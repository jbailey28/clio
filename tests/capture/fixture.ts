/**
 * A small, realistic source project for capture tests: a newsletter app with
 * one genuinely reusable piece (email_tools: normalize, validate and dedupe
 * email addresses), one trivial helper, and one function tied to the app.
 * Also a secret, a database and an .env file that must never be copied.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NORMALIZE = `"""Clean up email addresses: normalize, validate, dedupe.

Standard library only. Works on plain strings; knows nothing about the app.
"""
import re
import unicodedata

__all__ = ["normalize", "is_valid", "dedupe", "split_address"]

_LOCAL = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]+$")
_DOMAIN = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$")
_GMAIL = {"gmail.com", "googlemail.com"}


def split_address(address):
    """Return (local, domain), or raise ValueError when there is no single @."""
    text = unicodedata.normalize("NFKC", str(address)).strip()
    if text.count("@") != 1:
        raise ValueError("an email address has exactly one @: %r" % address)
    local, domain = text.split("@")
    return local, domain.lower().rstrip(".")


def is_valid(address):
    """True when the address is well formed. Does not check that the mailbox exists."""
    try:
        local, domain = split_address(address)
    except ValueError:
        return False
    if not local or len(local) > 64 or local.startswith(".") or local.endswith(".") or ".." in local:
        return False
    return bool(_LOCAL.match(local)) and bool(_DOMAIN.match(domain))


def normalize(address, gmail_rules=True):
    """Lower-case the domain, trim spaces and, for Gmail, drop dots and +tags.

    Raises ValueError for an address that is not valid.
    """
    if not is_valid(address):
        raise ValueError("not a valid email address: %r" % address)
    local, domain = split_address(address)
    if domain == "googlemail.com":
        domain = "gmail.com"
    if gmail_rules and domain in _GMAIL:
        local = local.split("+", 1)[0].replace(".", "")
    return "%s@%s" % (local.lower(), domain)


def dedupe(addresses, gmail_rules=True):
    """Valid addresses, normalized, first occurrence kept, original order.

    Returns (kept, rejected): rejected holds the inputs that were not valid.
    """
    kept, seen, rejected = [], set(), []
    for a in addresses:
        try:
            n = normalize(a, gmail_rules)
        except ValueError:
            rejected.append(a)
            continue
        if n not in seen:
            seen.add(n)
            kept.append(n)
    return kept, rejected
`;

const TESTS = `import sys
import unittest
from pathlib import Path

# The folder that holds email_tools, wherever it was copied to.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from email_tools import dedupe, is_valid, normalize, split_address  # noqa: E402


class NormalizeTest(unittest.TestCase):
    def test_lowercases_and_trims(self):
        self.assertEqual(normalize("  Ana@Example.COM "), "ana@example.com")

    def test_gmail_dots_and_tags(self):
        self.assertEqual(normalize("J.Smith+news@GoogleMail.com"), "jsmith@gmail.com")
        self.assertEqual(normalize("j.smith+news@gmail.com", gmail_rules=False), "j.smith+news@gmail.com")

    def test_invalid(self):
        for bad in ["", "no-at-sign", "a@@b.com", "a@b", ".a@b.com", "a..b@c.com", "a@-b.com"]:
            self.assertFalse(is_valid(bad), bad)
            with self.assertRaises(ValueError):
                normalize(bad)

    def test_split(self):
        self.assertEqual(split_address("x@Y.org."), ("x", "y.org"))

    def test_dedupe_keeps_order_and_reports_rejects(self):
        kept, rejected = dedupe(["B@x.com", "b@X.com", "bad", "a.b@gmail.com", "ab+1@gmail.com"])
        self.assertEqual(kept, ["b@x.com", "ab@gmail.com"])
        self.assertEqual(rejected, ["bad"])


if __name__ == "__main__":
    unittest.main()
`;

export function writeSourceProject(root: string) {
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w("requirements.txt", "flask==3.0.0\n");
  w(".env", "MAILER_API_KEY=live-key-do-not-copy\n");
  w("app/__init__.py", "");
  w("app/settings.py", 'import os\nMAILER_KEY = os.environ.get("MAILER_API_KEY", "")\n');
  w("app/db.py", "SUBSCRIBERS = []\n\ndef save(address):\n    SUBSCRIBERS.append(address)\n");
  w("app/signup.py", [
    "from app.db import save",
    "from app import settings",
    "from email_tools import normalize",
    "",
    "def sign_up(form):",
    "    if not settings.MAILER_KEY:",
    "        raise RuntimeError('mailer not configured')",
    "    save(normalize(form['email']))",
    "",
  ].join("\n"));
  w("app/utils/slug.py", "def slug(s):\n    return s.strip().lower().replace(' ', '-')\n");
  w("app/email_tools/__init__.py", "from .normalize import dedupe, is_valid, normalize, split_address\n");
  w("app/email_tools/normalize.py", NORMALIZE);
  w("app/email_tools/tests/test_normalize.py", TESTS);
  w("app/email_tools/README.md", "# email_tools\n\nNormalize, validate and dedupe email addresses. Standard library only.\n");
  // Things that sit inside the reusable folder but must never be copied.
  w("app/email_tools/.env.local", "SMTP_PASSWORD=hunter2hunter2\n");
  w("app/email_tools/subscribers.db", "SQLite format 3\0 jo@example.com ana@example.com");
  w("app/email_tools/__pycache__/normalize.cpython-39.pyc", "\0compiled");
  return {
    root,
    reusable: path.join(root, "app", "email_tools"),
    trivial: path.join(root, "app", "utils", "slug.py"),
    tied: path.join(root, "app", "signup.py"),
  };
}

/** sha256 over every file's path, bytes and mode: any change to the tree changes it. */
export function treeHash(dir: string): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const f = path.join(d, name);
      const st = fs.lstatSync(f);
      h.update(`${path.relative(dir, f)}\0${st.mode}\0`);
      if (st.isDirectory()) walk(f);
      else h.update(fs.readFileSync(f));
    }
  };
  walk(dir);
  return h.digest("hex");
}

export const TEST_COMMAND = "python3 -m unittest discover -s tests -p 'test_*.py'";
