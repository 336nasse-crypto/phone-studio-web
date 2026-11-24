#!/usr/bin/env python3
"""Verify the PWA: HTML parses, every id referenced by app.js exists,
every script/style/icon/manifest reference resolves to a real file,
the manifest is valid JSON with relative paths, and the service
worker precache list matches real files. Exit 0 on pass.
"""
import json
import os
import re
import sys
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
failures = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (" — " + detail if detail else ""))
    if not ok:
        failures.append(name)


class Checker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.scripts = []
        self.links = []
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if "id" in d:
            self.ids.add(d["id"])
        if tag == "script" and "src" in d:
            self.scripts.append(d["src"])
        if tag == "link" and "href" in d:
            self.links.append(d["href"])
        if tag not in ("meta", "link", "input", "br", "img", "hr"):
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in ("meta", "link", "input", "br", "img", "hr"):
            return
        if not self.stack or self.stack[-1] != tag:
            self.errors.append(f"mismatched </{tag}> (stack top: "
                               f"{self.stack[-1] if self.stack else 'empty'})")
            return
        self.stack.pop()


html = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
parser = Checker()
try:
    parser.feed(html)
    parser.close()
    check("HTML parses", not parser.errors, "; ".join(parser.errors)[:200])
except Exception as e:  # noqa: BLE001
    check("HTML parses", False, str(e))
check("HTML tags balanced", not parser.stack, "unclosed: " + ", ".join(parser.stack))

# Every id referenced by app.js / audio.js via $('...') or getElementById('...')
referenced = set()
for fname in ("app.js", "audio.js"):
    src = open(os.path.join(HERE, fname), encoding="utf-8").read()
    referenced |= set(re.findall(r"\$\('([^']+)'\)", src))
    referenced |= set(re.findall(r"getElementById\('([^']+)'\)", src))
# record-timer / level-bar are created dynamically in renderTracks.
referenced -= {"record-timer", "level-bar"}
missing = sorted(i for i in referenced if i not in parser.ids)
check("every id referenced in JS exists in HTML", not missing,
      "missing: " + ", ".join(missing) if missing else f"{len(referenced)} ids")

# Every script src + link href resolves to a real file (relative only).
for src in parser.scripts:
    ok = not src.startswith("/") and os.path.isfile(os.path.join(HERE, src))
    check(f"script resolves: {src}", ok)
for href in parser.links:
    ok = not href.startswith("/") and os.path.isfile(os.path.join(HERE, href))
    check(f"link resolves: {href}", ok)

# Manifest: valid JSON, required fields, relative paths only.
try:
    manifest = json.loads(open(os.path.join(HERE, "manifest.webmanifest"),
                               encoding="utf-8").read())
    check("manifest is valid JSON", True)
except Exception as e:  # noqa: BLE001
    manifest = None
    check("manifest is valid JSON", False, str(e))
if manifest:
    for field in ("name", "short_name", "display", "start_url", "scope", "icons"):
        check(f"manifest has {field}", field in manifest)
    check("manifest start_url is relative", manifest.get("start_url", "").startswith("./"))
    check("manifest scope is relative", manifest.get("scope", "").startswith("./"))
    check("manifest display is standalone", manifest.get("display") == "standalone")
    for icon in manifest.get("icons", []):
        src = icon.get("src", "")
        ok = not src.startswith("/") and os.path.isfile(os.path.join(HERE, src))
        check(f"manifest icon resolves: {src}", ok)

# Service worker: precache list matches real files, all relative.
sw = open(os.path.join(HERE, "sw.js"), encoding="utf-8").read()
m = re.search(r"var SHELL = \[(.*?)\];", sw, re.S)
precache = re.findall(r"'([^']+)'", m.group(1)) if m else []
check("sw.js has a precache list", bool(precache), f"{len(precache)} entries")
for entry in precache:
    path = entry[2:] if entry.startswith("./") else entry
    target = os.path.join(HERE, path) if path else os.path.join(HERE, "index.html")
    ok = entry.startswith("./") and os.path.isfile(target)
    check(f"sw precache resolves: {entry}", ok)
check("sw.js has no absolute paths", '"/' not in sw and "'/" not in sw)

# No absolute (root-relative) paths anywhere in the app files.
for fname in ("index.html", "app.js", "audio.js", "sw.js", "manifest.webmanifest"):
    src = open(os.path.join(HERE, fname), encoding="utf-8").read()
    bad = re.findall(r"""["']/(?!/)""", src)
    check(f"no root-relative paths in {fname}", not bad)

print()
print("ALL CHECKS PASSED" if not failures else f"{len(failures)} CHECK(S) FAILED")
sys.exit(0 if not failures else 1)
