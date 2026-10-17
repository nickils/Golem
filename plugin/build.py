#!/usr/bin/env python3
"""Build plugin/Golem.rbxmx from plugin/Golem.lua.

The plugin is one Script named "Golem" (Disabled=false) wrapped in a minimal
Roblox XML model. The build re-parses the result and compares Source
byte-for-byte, so a broken escape or a truncated file fails here instead of
inside Studio.

Run from this directory:  python3 build.py
"""

import os
import xml.etree.ElementTree as ET

os.chdir(os.path.dirname(os.path.abspath(__file__)))

src = open("Golem.lua", encoding="utf-8").read()

ctrl = sorted(set(c for c in src if ord(c) < 32 and c not in "\n\t"))
assert not ctrl, "source contains control chars: %r" % ctrl
assert "\r" not in src, "source contains carriage returns"
assert "]]>" not in src, "source would break the XML envelope"

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
assert item is not None and item.get("class") == "Script", "not a Script item"
props = {p.get("name"): p.text for p in item.find("Properties")}
assert props["Name"] == "Golem", props["Name"]
assert props["Disabled"] == "false", props["Disabled"]
assert props["Source"] == src, "Source round-trip mismatch"
print(
    "Golem.rbxmx OK: %d bytes, Source round-trips (%d chars, %d lines)"
    % (len(xml_doc.encode("utf-8")), len(src), src.count("\n") + 1)
)
