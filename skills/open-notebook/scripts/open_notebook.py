#!/usr/bin/env python3
"""Read-only, notebook-scoped Open Notebook client. Python standard library only."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

class ClientError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError("Redirect refused; configure the final OPEN_NOTEBOOK_URL.")


def record_id(value, table):
    if not isinstance(value, str) or not re.fullmatch(table + r":[A-Za-z0-9_-]+", value):
        raise ClientError("Expected a valid " + table + ":<id>.")
    return value


def page(text, offset, chars):
    text = text or ""
    end = min(len(text), offset + chars)
    return {"text": text[offset:end], "total_chars": len(text),
            "offset": offset, "next_offset": end if end < len(text) else None}


class Client:
    def __init__(self, password=None):
        url = os.environ.get("OPEN_NOTEBOOK_URL", "").strip().rstrip("/")
        if not url:
            raise ClientError("Set OPEN_NOTEBOOK_URL to your Open Notebook HTTPS URL before running this client.")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ClientError("OPEN_NOTEBOOK_URL must be an HTTPS URL without credentials, query or fragment.")
        self.base = url if url.endswith("/api") else url + "/api"
        self.password = password if password is not None else os.environ.get("OPEN_NOTEBOOK_PASSWORD")
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, params=None, body=None):
        if body is not None and path != "/search":
            raise ClientError("Only the read-only search POST is allowed.")
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json"}
        if self.password:
            headers["Authorization"] = "Bearer " + self.password
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers=headers)
        try:
            with self.opener.open(req, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise ClientError(f"API returned HTTP {exc.code}; check URL, access, model settings and server logs.") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ClientError("Connection failed; check Tailscale, NO_PROXY and server availability.") from None
        except (ValueError, UnicodeError):
            raise ClientError("API returned invalid JSON.") from None

    def notebooks(self):
        rows = self.request("/notebooks")
        return [{k: row.get(k) for k in ("id", "name", "archived", "source_count", "note_count")} for row in rows]

    def sources(self, notebook):
        record_id(notebook, "notebook")
        self.request("/notebooks/" + notebook)
        rows = []
        for offset in range(0, 100000, 100):
            batch = self.request("/sources", params={"notebook_id": notebook, "limit": 100, "offset": offset,
                                                      "sort_by": "created", "sort_order": "asc"})
            rows.extend(batch)
            if len(batch) < 100:
                return rows
        raise ClientError("Source pagination exceeded safety limit; refusing incomplete scope.")

    def source(self, notebook, source_id, allowed=None):
        record_id(source_id, "source")
        if allowed is None:
            allowed = {s["id"] for s in self.sources(notebook)}
        if source_id not in allowed:
            raise ClientError("Source is outside the selected notebook.")
        data = self.request("/sources/" + source_id)
        if data.get("id") != source_id or notebook not in (data.get("notebooks") or []):
            raise ClientError("Source membership could not be verified.")
        return data

    def source_list(self, notebook, title=None):
        rows = self.sources(notebook)
        if title:
            rows = [s for s in rows if title.casefold() in (s.get("title") or "").casefold()]
        # List endpoint reports embedded_chunks=0 even for indexed sources. Use detail for counts.
        return [{k: s.get(k) for k in ("id", "title", "embedded", "insights_count", "status")} for s in rows]

    def read(self, notebook, source_id, offset, chars):
        data = self.source(notebook, source_id)
        return {"id": source_id, "title": data.get("title"),
                "embedded": data.get("embedded"), "embedded_chunks": data.get("embedded_chunks"),
                **page(data.get("full_text"), offset, chars)}

    def insights(self, notebook, source_id, insight_id, offset, chars):
        self.source(notebook, source_id)
        rows = self.request("/sources/" + source_id + "/insights")
        rows = [r for r in rows if r.get("source_id") == source_id]
        if insight_id:
            record_id(insight_id, "source_insight")
            matches = [r for r in rows if r.get("id") == insight_id]
            if not matches:
                raise ClientError("Insight not found in the selected source.")
            row = matches[0]
            return {"id": insight_id, "source_id": source_id, "insight_type": row.get("insight_type"),
                    **page(row.get("content"), offset, chars)}
        return [{"id": r.get("id"), "source_id": source_id, "insight_type": r.get("insight_type"),
                 "total_chars": len(r.get("content") or "")} for r in rows]

    def search(self, notebook, query, kind, limit, chars):
        allowed = {s["id"] for s in self.sources(notebook)}
        data = self.request("/search", body={"query": query, "type": kind, "limit": limit,
                            "search_sources": True, "search_notes": False,
                            "notebook_ids": [notebook], "minimum_score": 0.2})
        kept, rejected = [], 0
        verified = {}
        for row in data.get("results", []):
            rid = row.get("id", "")
            if not isinstance(rid, str) or not rid.startswith(("source:", "source_insight:")):
                rejected += 1
                continue
            sid = rid
            if rid.startswith("source_insight:"):
                record_id(rid, "source_insight")
                # Resolve ownership inside the client; never print an unverified insight body.
                insight = self.request("/insights/" + rid)
                if insight.get("id") != rid:
                    rejected += 1
                    continue
                sid = insight.get("source_id")
            if sid not in allowed:
                rejected += 1
                continue
            if sid not in verified:
                try:
                    verified[sid] = self.source(notebook, sid, allowed)
                except ClientError:
                    rejected += 1
                    continue
            matches = row.get("matches") or []
            if not isinstance(matches, list) or any(not isinstance(m, str) for m in matches):
                raise ClientError("Unexpected search match format.")
            text = "\n\n".join(matches)
            kept.append({"id": rid, "source_id": sid, "title": verified[sid].get("title"),
                         "similarity": row.get("similarity"), "excerpt": text[:chars],
                         "truncated": len(text) > chars})
        return {"notebook_id": notebook, "type": kind, "results": kept,
                "discarded_out_of_scope": rejected,
                "warning": "Server scope is not trusted. Results are post-filtered; this is not exhaustive search."}


def bounded(low, high):
    def parse(value):
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"Expected {low}..{high}")
        return number
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="Connection, auth status and default embedding model, without secrets")
    sub.add_parser("notebooks", help="List notebook IDs and names")
    for name in ("sources", "read", "insights", "search"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--notebook", required=True, help="Exact notebook:<id>, not a name")
        if name == "sources":
            cmd.add_argument("--title", help="Case-insensitive substring filter")
        if name in ("read", "insights"):
            cmd.add_argument("--source", required=True)
            cmd.add_argument("--offset", type=bounded(0, 100000000), default=0)
            cmd.add_argument("--chars", type=bounded(1, 20000), default=6000)
        if name == "insights":
            cmd.add_argument("--insight", help="Omit to list insight metadata; provide ID to read")
        if name == "search":
            cmd.add_argument("query")
            cmd.add_argument("--type", choices=("text", "vector"), default="text")
            cmd.add_argument("--limit", type=bounded(1, 100), default=10)
            cmd.add_argument("--chars", type=bounded(1, 6000), default=1500, help="Maximum excerpt characters per result")
    args = parser.parse_args()
    try:
        client = Client()
        if args.command == "status":
            config = client.request("/config")
            auth = client.request("/auth/status")
            defaults = client.request("/models/defaults")
            models = client.request("/models")
            model = next((m for m in models if m.get("id") == defaults.get("default_embedding_model")), {})
            result = {"version": config.get("version"), "db_status": config.get("dbStatus"),
                      "auth_enabled": auth.get("auth_enabled"),
                      "embedding_model": {k: model.get(k) for k in ("id", "name", "provider", "type")}}
        elif args.command == "notebooks":
            result = client.notebooks()
        elif args.command == "sources":
            result = client.source_list(args.notebook, args.title)
        elif args.command == "read":
            result = client.read(args.notebook, args.source, args.offset, args.chars)
        elif args.command == "insights":
            result = client.insights(args.notebook, args.source, args.insight, args.offset, args.chars)
        else:
            result = client.search(args.notebook, args.query, args.type, args.limit, args.chars)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ClientError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
