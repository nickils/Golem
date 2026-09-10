#!/usr/bin/env python3
"""Build plugin/Golem.rbxmx from plugin/Golem.lua.

Wraps the single-Script source in a minimal Roblox XML envelope
(top-level Script named "Golem", Disabled=false) and verifies the
result by parsing it back and comparing the Source byte-for-byte.
Run from this directory:  python3 build.py
"""
import os
import xml.etree.ElementTree as ET

os.chdir(os.path.dirname(os.path.abspath(__file__)))

src = open("Golem.lua", encoding="utf-8").read()

ctrl = sorted(set(c for c in src if ord(c) < 32 and c != "\n"))
assert not ctrl, "source contains control chars: %r" % ctrl

esc = src.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
xml_doc = (
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">'
    '<Meta name="ExplicitAutoJoints">true</Meta><External>null</External><External>nil</External>'
    '<Item class="Script" referent="RBX0"><Properties>'
    '<string name="Name">Golem</string>'
    '<bool name="Disabled">false</bool>'
    '<ProtectedString name="Source">' + esc + "</ProtectedString>"
    "</Properties></Item></roblox>"
)
open("Golem.rbxmx", "w", encoding="utf-8", newline="").write(xml_doc)

root = ET.parse("Golem.rbxmx").getroot()
item = root.find("Item")
assert item.get("class") == "Script"
props = {p.get("name"): p.text for p in item.find("Properties")}
assert props["Name"] == "Golem", props
assert props["Disabled"] == "false", props
assert props["Source"] == src, "Source round-trip mismatch"
print("Golem.rbxmx OK: %d bytes, Source round-trips (%d chars)" % (
    len(xml_doc.encode("utf-8")), len(src)))
