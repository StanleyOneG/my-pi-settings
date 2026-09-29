import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("open_notebook", Path(__file__).parents[1] / "scripts/open_notebook.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NB = "notebook:test"
SRC = "source:allowed"


class Fake(m.Client):
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def request(self, path, params=None, body=None):
        self.calls.append((path, params, body))
        result = self.responses[path]
        return result(params) if callable(result) else result


def responses():
    return {"/notebooks/" + NB: {"id": NB},
            "/sources": [{"id": SRC, "title": "Meeting"}],
            "/sources/" + SRC: {"id": SRC, "title": "Meeting", "notebooks": [NB], "full_text": "abcdef"}}


class Tests(unittest.TestCase):
    def test_read_pages(self):
        client = Fake(responses())
        self.assertEqual(client.read(NB, SRC, 0, 3)["next_offset"], 3)
        self.assertEqual(client.read(NB, SRC, 3, 3)["text"], "def")
        self.assertIsNone(client.read(NB, SRC, 3, 3)["next_offset"])

    def test_foreign_source_not_fetched(self):
        client = Fake(responses())
        with self.assertRaises(m.ClientError):
            client.read(NB, "source:foreign", 0, 3)
        self.assertNotIn("/sources/source:foreign", [c[0] for c in client.calls])

    def test_membership_checked_in_detail(self):
        data = responses()
        data["/sources/" + SRC]["notebooks"] = ["notebook:elsewhere"]
        with self.assertRaises(m.ClientError):
            Fake(data).read(NB, SRC, 0, 3)

    def test_search_discards_foreign_source_and_insight(self):
        data = responses()
        data["/search"] = {"results": [
            {"id": SRC, "parent_id": SRC, "matches": ["good excerpt"], "similarity": .7},
            {"id": "source:foreign", "matches": ["SECRET ONE"]},
            {"id": "source_insight:foreign", "parent_id": SRC, "matches": ["SECRET TWO"]},
            {"id": "source_insight:valid", "matches": ["good insight"]}]}
        data["/insights/source_insight:foreign"] = {"id": "source_insight:foreign", "source_id": "source:foreign", "content": "SECRET"}
        data["/insights/source_insight:valid"] = {"id": "source_insight:valid", "source_id": SRC}
        client = Fake(data)
        result = client.search(NB, "question", "vector", 10, 100)
        self.assertEqual(result["discarded_out_of_scope"], 2)
        self.assertEqual(len(result["results"]), 2)
        self.assertNotIn("SECRET", str(result))
        body = next(c[2] for c in client.calls if c[0] == "/search")
        self.assertEqual(body["notebook_ids"], [NB])
        self.assertFalse(body["search_notes"])

    def test_empty_scope_rejected_before_network(self):
        client = Fake(responses())
        for value in ["", "Servers Management", "notebook:x/../../models", None]:
            with self.assertRaises(m.ClientError):
                client.sources(value)
        self.assertEqual(client.calls, [])

    def test_pagination(self):
        data = responses()
        data["/sources"] = lambda params: [{"id": f"source:{i}"} for i in range(100)] if params["offset"] == 0 else [{"id": "source:last"}]
        self.assertEqual(len(Fake(data).sources(NB)), 101)

    def test_insights_scoped_and_paginated(self):
        data = responses()
        data["/sources/" + SRC + "/insights"] = [
            {"id": "source_insight:valid", "source_id": SRC, "content": "abcdef"},
            {"id": "source_insight:foreign", "source_id": "source:foreign", "content": "SECRET"}]
        client = Fake(data)
        self.assertEqual(len(client.insights(NB, SRC, None, 0, 3)), 1)
        self.assertEqual(client.insights(NB, SRC, "source_insight:valid", 3, 3)["text"], "def")
        with self.assertRaises(m.ClientError):
            client.insights(NB, SRC, "source_insight:foreign", 0, 3)

    def test_url_validation(self):
        for url in ["http://example.com", "https://user:secret@example.com", "https://example.com?token=x"]:
            with patch.dict(m.os.environ, {"OPEN_NOTEBOOK_URL": url}):
                with self.assertRaises(m.ClientError):
                    m.Client()
        with patch.dict(m.os.environ, {"OPEN_NOTEBOOK_URL": "https://example.com/api/"}):
            self.assertEqual(m.Client().base, "https://example.com/api")

    def test_url_required(self):
        for env in [{}, {"OPEN_NOTEBOOK_URL": ""}, {"OPEN_NOTEBOOK_URL": "  "}]:
            with patch.dict(m.os.environ, env, clear=True):
                with self.assertRaisesRegex(m.ClientError, "Set OPEN_NOTEBOOK_URL"):
                    m.Client()

    def test_write_refused(self):
        with patch.dict(m.os.environ, {"OPEN_NOTEBOOK_URL": "https://example.com"}):
            with self.assertRaisesRegex(m.ClientError, "read-only search POST"):
                m.Client().request("/notes", body={"content": "write"})

    def test_redirect_refused(self):
        with self.assertRaises(m.ClientError):
            m.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.test")


if __name__ == "__main__":
    unittest.main()
