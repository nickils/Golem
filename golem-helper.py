#!/usr/bin/env python3
"""Golem helper - control a live Roblox Studio session from anywhere.

The Studio plugin polls the command channel below and posts results to the
result channel. This helper sends a command, waits for the matching result,
and prints it as JSON. Python 3.8+, no dependencies.

Usage:
    python3 golem-helper.py ping
    python3 golem-helper.py debug                           # full connection + marketplace diagnostics
    python3 golem-helper.py exec '{"op":"list","args":{"path":"game"}}'
    python3 golem-helper.py lua 'return 1+1'
    python3 golem-helper.py lua - < code.lua
    python3 golem-helper.py list ServerScriptService
    python3 golem-helper.py list game --recursive --max 1000
    python3 golem-helper.py tree game --depth 3
    python3 golem-helper.py read ServerScriptService/Main
    python3 golem-helper.py find Coin --class Part --scope Workspace
    python3 golem-helper.py grep applyDamage --scope ServerScriptService
    python3 golem-helper.py script ReplicatedStorage Config --class ModuleScript < source.lua
    python3 golem-helper.py delete Workspace/OldPart
    python3 golem-helper.py move Workspace/Part ServerStorage
    python3 golem-helper.py selection --set Workspace/Part
    python3 golem-helper.py waypoint "before refactor"
    python3 golem-helper.py turn begin
    python3 golem-helper.py turn end --note "short reply the user reads in the chat"
    python3 golem-helper.py place <path> <x,y,z> [--orientation x,y,z]   # absolute position
    python3 golem-helper.py paint <path> [--color #RRGGBB] [--material Grass] [--transparency 0.2]
    python3 golem-helper.py rename <path> <newName>
    python3 golem-helper.py look <path> [--distance 40]     # aim the editor camera
    python3 golem-helper.py count [scope] [--class Part]    # quick instance count
    python3 golem-helper.py undo                            # one Studio undo step
    python3 golem-helper.py anchor <path> [--off]           # anchor parts (models: all parts)
    python3 golem-helper.py collide <path> [--off]          # toggle collision
    python3 golem-helper.py light <path> [--type point|spot|surface] [--color #RRGGBB] [--range 30] [--brightness 1]
    python3 golem-helper.py sound <parent> <audioId> [--volume 0.5] [--loop] [--play] [--name N]
    python3 golem-helper.py scatter <path> --count 20 --radius 60 [--y-jitter 2] [--parent P]
    python3 golem-helper.py weld <path>                        # weld a model's parts together
    python3 golem-helper.py hitbox <path> [--padding 1] [--name N] [--collide]
    python3 golem-helper.py prompt <path> "Chop" [--object Tree] [--hold 0.5] [--distance 8]
    python3 golem-helper.py particles <path> leaves|sparks|smoke|magic|fire|snow|rain|bubbles|dust|confetti|fireflies [--rate N] [--color #RRGGBB]
    python3 golem-helper.py sign "Camp rules: no griefing" [--position x,y,z] [--parent P] [--size 6,4,0.5]
    python3 golem-helper.py attr <path> [--set k=v ...] [--clear k ...]     # Studio attributes
    python3 golem-helper.py beam <FROM> <TO> [--color #RRGGBB] [--width 0.4] [--curve 0]   # glowing beam between parts
    python3 golem-helper.py trail <path> [--color #RRGGBB] [--lifetime 0.6]  # motion trail on a moving part
    python3 golem-helper.py explosion [--position x,y,z] [--radius 8]        # one-shot boom (visual only)
    python3 golem-helper.py ui_screen <name> [--parent P] [--order N]        # ScreenGui under StarterGui
    python3 golem-helper.py ui_frame <parent> <name> [--position 0,0,0,0] [--size 1,0,1,0] [--anchor 0,0]
                       [--color #RRGGBB] [--radius 8] [--transparency 0] [--clip]
    python3 golem-helper.py ui_label <parent> <name> --text "..." [--align left|center|right] [--wrap]
                       [--color #RRGGBB] [--font medium] [--text-size 16]
    python3 golem-helper.py ui_button <parent> <name> --text "..." [--color #RRGGBB] [--text-color #RRGGBB]
    python3 golem-helper.py ui_input <parent> <name> [--placeholder "..."] [--background #RRGGBB]
    python3 golem-helper.py ui_image <parent> <name> --asset <assetId> [--scale fit|stretch|tile]
    python3 golem-helper.py ui_list <parent> [--direction vertical|horizontal] [--padding 8]
                       [--halign left|center|right] [--valign top|middle|bottom]
    python3 golem-helper.py play [--mode play|run]               # start play-testing the game
    python3 golem-helper.py stop                                 # stop the play test
    python3 golem-helper.py logs [--all] [--limit N] [--since TS]  # output log (errors+warnings by default)
    python3 golem-helper.py tag <path> --add Choppable [--remove Old]       # + find --tag Choppable
    python3 golem-helper.py match <from> <to...>              # copy color/material onto targets
    python3 golem-helper.py search <query> [--category C] [--limit N]   # marketplace (runs directly, no Studio)
    python3 golem-helper.py info <assetId>                   # asset details (runs directly, no Studio)
    python3 golem-helper.py insert <assetId> [parent]        # place a FREE marketplace asset into the place

Add --timeout N (seconds, default 120) to any command.
Exit codes: 0 = ok, 1 = Studio reported an error, 2 = transport/usage error.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FIREBASE_DB = os.environ.get("AIB_FIREBASE_DB", "__DB_URL__")
CHANNEL = os.environ.get("AIB_CHANNEL", "__CHANNEL_ID__")
CMD_URL = "%s/channels/%s/cmd" % (FIREBASE_DB, CHANNEL)
RES_URL = "%s/channels/%s/res" % (FIREBASE_DB, CHANNEL)
POLL_INTERVAL = float(os.environ.get("AIB_POLL_INTERVAL", "2"))


def vec3(s):
    parts = [float(v) for v in str(s).replace(",", " ").split()]
    if not parts:
        raise ValueError("empty vector")
    if len(parts) == 1:
        return {"x": parts[0], "y": 0.0, "z": 0.0}
    if len(parts) != 3:
        raise ValueError("expected x,y,z")
    return {"x": parts[0], "y": parts[1], "z": parts[2]}


def _post(url, body, timeout=30):
    req = urllib.request.Request(url, data=body.encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _get(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


MARKETPLACE_CATEGORIES = {
    "model": "Model", "models": "Model", "mesh": "MeshPart", "meshes": "MeshPart",
    "meshpart": "MeshPart", "decal": "Decal", "decals": "Decal", "image": "Decal",
    "images": "Decal", "picture": "Decal", "texture": "Decal", "audio": "Audio",
    "sound": "Audio", "sounds": "Audio", "music": "Audio", "video": "Video",
    "videos": "Video", "plugin": "Plugin", "plugins": "Plugin",
}
ASSET_TYPE_NAMES = {1: "Image", 3: "Audio", 4: "Mesh", 9: "Decal", 10: "Model",
                    18: "Video", 19: "Font", 40: "MeshPart"}


def marketplace_get(url, timeout=20):
    req = urllib.request.Request(url, headers={
        "Accept": "application/json", "User-Agent": "Golem-aib/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def marketplace_search(query, category="model", limit=10, cursor=None):
    asset_type = MARKETPLACE_CATEGORIES.get(str(category or "model").lower())
    if asset_type is None:
        raise ValueError("unknown category '%s' (valid: model, mesh, image, audio, video, plugin)" % category)
    try:
        limit = max(1, min(int(limit or 10), 50))
    except (TypeError, ValueError):
        limit = 10
    url = ("https://apis.roblox.com/toolbox-service/v1/marketplace/%s?keyword=%s&limit=%d"
           % (asset_type, urllib.parse.quote(str(query)), limit))
    if cursor:
        url += "&cursor=" + urllib.parse.quote(str(cursor))
    data = marketplace_get(url)
    ids = [it["id"] for it in (data.get("data") or [])
           if isinstance(it, dict) and it.get("id") is not None]
    details, thumbs = {}, {}
    for i, aid in enumerate(ids[:12]):
        try:
            details[aid] = marketplace_get("https://economy.roblox.com/v2/assets/%s/details" % aid)
        except Exception:
            pass
        if i < 11:
            time.sleep(0.4)  # the economy API rate limits hard
    if ids:
        try:
            tdata = marketplace_get(
                "https://thumbnails.roblox.com/v1/assets?assetIds=%s&size=420x420&format=Png"
                % ",".join(str(x) for x in ids[:12]))
            for th in (tdata.get("data") or []):
                if isinstance(th, dict) and th.get("targetId") is not None:
                    thumbs[th["targetId"]] = th
        except Exception:
            pass
    results = []
    for aid in ids:
        d, th = details.get(aid), thumbs.get(aid)
        entry = {"id": aid, "category": asset_type}
        if isinstance(d, dict):
            entry["name"] = d.get("Name")
            entry["assetTypeId"] = d.get("AssetTypeId")
            entry["assetType"] = ASSET_TYPE_NAMES.get(d.get("AssetTypeId"))
            creator = d.get("Creator")
            if isinstance(creator, dict):
                entry["creator"] = creator.get("Name")
            if d.get("PriceInRobux") is not None:
                entry["priceInRobux"] = d["PriceInRobux"]
            if d.get("IsForSale") is not None:
                entry["forSale"] = d["IsForSale"]
            desc = d.get("Description")
            if isinstance(desc, str) and desc:
                entry["description"] = desc[:280]
        else:
            entry["detailsUnavailable"] = True
        if isinstance(th, dict):
            entry["thumbnail"] = th.get("imageUrl")
            entry["thumbnailState"] = th.get("state")
        results.append(entry)
    out = {"totalResults": data.get("totalResults"), "results": results}
    if data.get("nextPageCursor"):
        out["nextPageCursor"] = data["nextPageCursor"]
    return out


def marketplace_info(asset_id):
    d = marketplace_get("https://economy.roblox.com/v2/assets/%s/details" % int(asset_id))
    out = {"id": int(asset_id)}
    if isinstance(d, dict):
        out["name"] = d.get("Name")
        out["assetTypeId"] = d.get("AssetTypeId")
        out["assetType"] = ASSET_TYPE_NAMES.get(d.get("AssetTypeId"))
        creator = d.get("Creator")
        if isinstance(creator, dict):
            out["creator"] = creator.get("Name")
        if d.get("PriceInRobux") is not None:
            out["priceInRobux"] = d["PriceInRobux"]
        if d.get("IsForSale") is not None:
            out["forSale"] = d["IsForSale"]
        desc = d.get("Description")
        if isinstance(desc, str):
            out["description"] = desc[:1000]
    try:
        tdata = marketplace_get(
            "https://thumbnails.roblox.com/v1/assets?assetIds=%d&size=420x420&format=Png" % int(asset_id))
        if isinstance(tdata.get("data"), list) and tdata["data"]:
            out["thumbnail"] = tdata["data"][0].get("imageUrl")
            out["thumbnailState"] = tdata["data"][0].get("state")
    except Exception:
        pass
    return out


def _marketplace_via_plugin():
    return os.environ.get("AIB_MARKETPLACE", "").lower() == "plugin"


def call(op, args=None, timeout=120):
    if str(FIREBASE_DB).startswith("__") or str(CHANNEL).startswith("__"):
        return {"ok": False, "error": "helper not configured (channel never stamped) - re-run: npx golem-bridge connect <channelId>"}
    cid = "c%d" % time.time_ns()
    payload = json.dumps({"id": cid, "op": op, "args": args or {}, "ts": int(time.time())})
    try:
        pub = None
        for attempt in range(4):
            try:
                pub = _post(CMD_URL + ".json", payload)
                break
            except urllib.error.HTTPError as exc:
                if exc.code == 429 and attempt < 3:
                    time.sleep(float(exc.headers.get("Retry-After") or (5 * (attempt + 1))))
                else:
                    raise
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": "relay rejected the command: HTTP %d: %s" % (exc.code, exc.read()[:200])}
    except Exception as exc:
        return {"ok": False, "error": "cannot reach the relay (%s) - check internet/DNS" % exc}

    since_key = str((pub or {}).get("name") or "") or None
    deadline = time.time() + timeout
    attempt = 0
    while time.time() < deadline:
        try:
            body = _get(RES_URL + ".json?shallow=true")  # keys only - tiny
            attempt = 0
            keys = json.loads(body) if body != "null" else {}
            if isinstance(keys, dict):
                for key in sorted(k for k in keys if since_key is None or k > since_key):
                    since_key = key
                    raw = _get(RES_URL + "/" + key + ".json")
                    try:
                        entry = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(entry, dict) and entry.get("id") == cid:
                        if entry.get("resultEncoded") and isinstance(entry.get("result"), str):
                            try:
                                entry["result"] = json.loads(entry["result"])
                            except ValueError:
                                pass
                            entry.pop("resultEncoded", None)
                        return entry
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                time.sleep(float(exc.headers.get("Retry-After") or 6))
            else:
                time.sleep(2)
            continue
        except Exception:
            attempt += 1
            time.sleep(min(15.0, 0.5 * (2 ** min(attempt, 5))))
            continue
        time.sleep(POLL_INTERVAL)
    return {
        "ok": False,
        "error": "timed out after %ds waiting for Studio to answer '%s'. Is Roblox Studio open with the Golem "
                 "plugin connected to the relay?" % (timeout, op),
    }


def status():
    """Read the relay channel's recent history and decode the plugin's liveness
    beacons. No Studio round-trip needed."""
    if str(CMD_URL).startswith("__") or str(RES_URL).startswith("__"):  # no literal placeholders - see call()
        return {"ok": False, "error": "helper not configured (channel never stamped) - re-run: npx golem-bridge connect <channelId>"}
    try:
        beacon_body = _get(
            "%s/channels/%s/beacons.json?orderBy=%s&limitToLast=5"
            % (FIREBASE_DB, CHANNEL, urllib.parse.quote('"$key"')), timeout=30)
        beacon_data = json.loads(beacon_body) if beacon_body != "null" else {}
        if not isinstance(beacon_data, dict):
            beacon_data = {}
        res_body = _get(RES_URL + ".json?shallow=true", timeout=30)
        res_keys = json.loads(res_body) if res_body != "null" else {}
        if not isinstance(res_keys, dict):
            res_keys = {}
        results = sum(1 for v in res_keys.values() if v is True)
    except Exception as exc:
        return {"ok": False, "error": "cannot read the relay channel: %s" % exc}
    now = time.time()
    beacons = []
    for entry in beacon_data.values():
        if isinstance(entry, dict) and entry.get("op") in ("hello", "paused", "revoked"):
            beacons.append((float(entry.get("ts") or 0), entry))
    if not beacons:
        if results:
            verdict = ("no beacons, but %d cached result(s) - Studio is not running or runs an "
                       "older plugin; ask the user to fully restart Studio with the current plugin" % results)
        else:
            verdict = ("result channel is empty - the plugin has never posted here: Studio is closed "
                       "or was not restarted after a plugin update")
        return {"ok": True, "beacon": None, "ageSeconds": None, "recentResults": results, "verdict": verdict}
    ts, beacon = max(beacons, key=lambda b: b[0])
    age = max(0, int(now - ts))
    op = beacon.get("op")
    ver = beacon.get("v", "?")
    if age <= 900:
        verdict = "plugin is LIVE (v%s, hello beacon %ds ago) - it should answer commands" % (ver, age)
    else:
        verdict = ("last hello was %d min ago (v%s) - Studio may be closed or hung since then; ask the "
                   "user to check the Golem window" % (age // 60, ver))
    return {"ok": True, "beacon": beacon, "ageSeconds": age, "recentResults": results, "verdict": verdict}


def _turn_reminder(entry):
    if isinstance(entry, dict) and entry.get("turnOpen"):
        helper = (sys.argv and sys.argv[0]) or "golem-helper.py"
        n = entry.get("turnTools")
        head = (">> TURN STILL OPEN (%d tools) - do NOT reply yet." % n
                if isinstance(n, int) else ">> TURN STILL OPEN - do NOT reply yet.")
        print(head + " When this task is done, close it with:\n"
              '>>    python3 "%s" turn end --note "your reply"' % helper,
              file=sys.stderr)


def _out(data, as_json=False, raw_field=None):
    if data.get("ok"):
        if raw_field and not as_json:
            result = data.get("result") or {}
            if isinstance(result.get(raw_field), str):
                sys.stdout.write(result[raw_field])
                if not result[raw_field].endswith("\n"):
                    sys.stdout.write("\n")
                _turn_reminder(data)
                return 0
        print(json.dumps(data, indent=2))
        _turn_reminder(data)
        return 0
    print(json.dumps(data, indent=2), file=sys.stderr)
    _turn_reminder(data)
    return 1 if "error" in data else 2


def main():
    ap = argparse.ArgumentParser(description="Golem helper for Roblox Studio", prog="golem-helper.py")
    ap.add_argument("--timeout", type=float, default=120.0, help="seconds to wait for Studio (default 120)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ping", help="health check - is Studio connected?")

    sub.add_parser("debug", help="diagnostics: relay round-trip, marketplace reachability, HTTP state")

    sub.add_parser("status", help="is the plugin alive, paused, or the link revoked? (no Studio needed)")

    p = sub.add_parser("exec", help="send a raw op JSON: {\"op\":..., \"args\":...}")
    p.add_argument("json")

    p = sub.add_parser("lua", help="run Lua inside Studio (code arg, or - for stdin)")
    p.add_argument("code", nargs="?")
    p.add_argument("-", dest="from_stdin", action="store_true")

    p = sub.add_parser("list", help="children of a path")
    p.add_argument("path", nargs="?", default="game")
    p.add_argument("--recursive", action="store_true")
    p.add_argument("--max", type=int)

    p = sub.add_parser("tree", help="recursive tree of a path")
    p.add_argument("path", nargs="?", default="game")
    p.add_argument("--depth", type=int)

    p = sub.add_parser("read", help="read an instance (script source by default, --json for full record)")
    p.add_argument("path")
    p.add_argument("--json", action="store_true", dest="as_json")
    p.add_argument("--props", help="comma-separated extra properties")

    p = sub.add_parser("find", help="find instances by name or --tag")
    p.add_argument("query", nargs="?", default="")
    p.add_argument("--class", dest="cls")
    p.add_argument("--scope", default="game")
    p.add_argument("--max", type=int)
    p.add_argument("--exact", action="store_true")
    p.add_argument("--tag", help="find by CollectionService tag instead of name")

    p = sub.add_parser("grep", help="search script sources")
    p.add_argument("pattern")
    p.add_argument("--scope", default="game")
    p.add_argument("--max", type=int)
    p.add_argument("-i", action="store_true", dest="icase", help="case-insensitive")

    p = sub.add_parser("script", help="create/update a script (source from stdin or --source)")
    p.add_argument("parent")
    p.add_argument("name")
    p.add_argument("--class", dest="cls", default="Script",
                   choices=["Script", "LocalScript", "ModuleScript"])
    p.add_argument("--mode", choices=["create", "update", "replace"], default="create")
    p.add_argument("--source")

    p = sub.add_parser("delete", help="delete instances")
    p.add_argument("paths", nargs="+")

    p = sub.add_parser("move", help="reparent an instance")
    p.add_argument("path")
    p.add_argument("parent")

    p = sub.add_parser("selection", help="read or set the Studio selection")
    p.add_argument("--set", help="comma-separated paths")
    p.add_argument("--clear", action="store_true")

    p = sub.add_parser("waypoint", help="set an undo checkpoint")
    p.add_argument("label", nargs="?", default="bridge")

    p = sub.add_parser("say", help="post a message to the user's Studio chat (closes the turn)")
    p.add_argument("text")

    p = sub.add_parser("turn", help="mark work turns: begin ... tools ... end --note (required protocol)")
    p.add_argument("action", choices=["begin", "end"])
    p.add_argument("--note", help="the user-facing reply, posted when the turn ends")

    p = sub.add_parser("rotate", help="rotate: --axis y --degrees 90 (relative) or --set 0,90,0 (absolute)")
    p.add_argument("path")
    p.add_argument("--axis", help="x|y|z|up|right|forward (or x,y,z vector)")
    p.add_argument("--degrees", type=float)
    p.add_argument("--set", dest="absolute", help="absolute orientation x,y,z in degrees")
    p.add_argument("--space", choices=["world", "local"], default="world")

    p = sub.add_parser("face", help="aim an instance's axis at a world point (keeps position)")
    p.add_argument("path")
    p.add_argument("target", help="x,y,z world position to face")
    p.add_argument("--axis", default="forward", help="forward (default) | up | right")

    p = sub.add_parser("shift", help="move by an offset in studs (world or local)")
    p.add_argument("path")
    p.add_argument("offset", help="x,y,z studs")
    p.add_argument("--space", choices=["world", "local"], default="world")

    p = sub.add_parser("scale", help="scale a part/model by a relative factor")
    p.add_argument("path")
    p.add_argument("factor", type=float)

    p = sub.add_parser("duplicate", help="clone an instance (optionally N times with spacing)")
    p.add_argument("path")
    p.add_argument("--count", type=int, default=1)
    p.add_argument("--offset", help="x,y,z applied per copy (copy i gets offset*i)")
    p.add_argument("--parent")
    p.add_argument("--name")

    p = sub.add_parser("group", help="wrap instances into a Model")
    p.add_argument("paths", nargs="+")
    p.add_argument("--name", default="Group")
    p.add_argument("--parent")

    p = sub.add_parser("pivot", help="set a model/part pivot (what it rotates around)")
    p.add_argument("path")
    p.add_argument("--position", help="x,y,z world position")
    p.add_argument("--orientation", help="x,y,z degrees")

    p = sub.add_parser("place", help="absolute position via pivot (parts and models)")
    p.add_argument("path")
    p.add_argument("position", help="x,y,z world position")
    p.add_argument("--orientation", help="x,y,z degrees")

    p = sub.add_parser("paint", help="set color/material/transparency/reflectance on parts")
    p.add_argument("paths", nargs="+")
    p.add_argument("--color", help="#RRGGBB")
    p.add_argument("--material", help="Grass, Neon, WoodPlanks, ...")
    p.add_argument("--transparency", type=float)
    p.add_argument("--reflectance", type=float)

    p = sub.add_parser("rename", help="rename an instance")
    p.add_argument("path")
    p.add_argument("name")

    p = sub.add_parser("look", help="aim the Studio editor camera at a path")
    p.add_argument("path")
    p.add_argument("--distance", type=float, default=30)

    p = sub.add_parser("count", help="count instances (cheap, no payloads)")
    p.add_argument("scope", nargs="?", default="game")
    p.add_argument("--class", dest="cls")

    sub.add_parser("undo", help="one Studio undo step (Ctrl+Z)")

    p = sub.add_parser("anchor", help="anchor parts in place (models: all their parts)")
    p.add_argument("paths", nargs="+")
    p.add_argument("--off", action="store_true", help="unanchor instead of anchor")

    p = sub.add_parser("collide", help="enable part collision (models: all their parts)")
    p.add_argument("paths", nargs="+")
    p.add_argument("--off", action="store_true", help="disable collision instead of enabling")

    p = sub.add_parser("light", help="add or update a light inside a part")
    p.add_argument("path")
    p.add_argument("--type", dest="light_type", default="point", choices=["point", "spot", "surface"])
    p.add_argument("--color")
    p.add_argument("--range", type=float)
    p.add_argument("--brightness", type=float)
    p.add_argument("--shadows", action="store_true")

    p = sub.add_parser("sound", help="add a Sound to a parent, optionally play it")
    p.add_argument("parent")
    p.add_argument("id")
    p.add_argument("--volume", type=float)
    p.add_argument("--loop", action="store_true")
    p.add_argument("--play", action="store_true")
    p.add_argument("--name")

    p = sub.add_parser("weld", help="weld a model's parts together with WeldConstraints")
    p.add_argument("paths", nargs="+")

    p = sub.add_parser("hitbox", help="invisible hitbox part sized to a target")
    p.add_argument("path")
    p.add_argument("--padding", type=float, default=0.5)
    p.add_argument("--name")
    p.add_argument("--collide", action="store_true", help="make the hitbox collidable")

    p = sub.add_parser("prompt", help="add a ProximityPrompt to a part (Press E to ...)")
    p.add_argument("path")
    p.add_argument("action")
    p.add_argument("--object", help="title above the prompt (e.g. the object's name)")
    p.add_argument("--hold", type=float, default=0)
    p.add_argument("--distance", type=float, default=8)

    p = sub.add_parser("particles", help="attach a particle preset to a part")
    p.add_argument("path")
    p.add_argument("preset", choices=["leaves", "sparks", "smoke", "magic", "fire",
                                    "snow", "rain", "bubbles", "dust", "confetti", "fireflies"])
    p.add_argument("--rate", type=float)
    p.add_argument("--color")

    p = sub.add_parser("sign", help="place a readable wooden sign")
    p.add_argument("text")
    p.add_argument("--position")
    p.add_argument("--parent")
    p.add_argument("--size")
    p.add_argument("--name")

    p = sub.add_parser("beam", help="glowing beam between two parts")
    p.add_argument("from")  # keyword name; read with getattr(ns, "from")
    p.add_argument("to")
    p.add_argument("--color")
    p.add_argument("--width", type=float)
    p.add_argument("--curve", type=float)
    p.add_argument("--name")

    p = sub.add_parser("trail", help="motion trail on a moving part")
    p.add_argument("path")
    p.add_argument("--color")
    p.add_argument("--lifetime", type=float)
    p.add_argument("--name")

    p = sub.add_parser("explosion", help="one-shot explosion (visual only)")
    p.add_argument("--position")
    p.add_argument("--radius", type=float)

    p = sub.add_parser("ui_screen", help="create a ScreenGui under StarterGui")
    p.add_argument("name")
    p.add_argument("--parent")
    p.add_argument("--order", type=int)

    p = sub.add_parser("ui_frame", help="rounded panel/frame")
    p.add_argument("parent")
    p.add_argument("name")
    p.add_argument("--position")
    p.add_argument("--size")
    p.add_argument("--anchor")
    p.add_argument("--color")
    p.add_argument("--transparency", type=float)
    p.add_argument("--radius", type=int)
    p.add_argument("--clip", action="store_true")

    p = sub.add_parser("ui_label", help="text label")
    p.add_argument("parent")
    p.add_argument("name")
    p.add_argument("--text")
    p.add_argument("--position")
    p.add_argument("--size")
    p.add_argument("--anchor")
    p.add_argument("--color")
    p.add_argument("--align")
    p.add_argument("--font")
    p.add_argument("--text-size", type=int)
    p.add_argument("--wrap", action="store_true")

    p = sub.add_parser("ui_button", help="text button")
    p.add_argument("parent")
    p.add_argument("name")
    p.add_argument("--text")
    p.add_argument("--position")
    p.add_argument("--size")
    p.add_argument("--anchor")
    p.add_argument("--color")
    p.add_argument("--text-color")
    p.add_argument("--radius", type=int)
    p.add_argument("--font")
    p.add_argument("--text-size", type=int)

    p = sub.add_parser("ui_input", help="TextBox the player can type into")
    p.add_argument("parent")
    p.add_argument("name")
    p.add_argument("--placeholder")
    p.add_argument("--text")
    p.add_argument("--position")
    p.add_argument("--size")
    p.add_argument("--color")
    p.add_argument("--background")
    p.add_argument("--radius", type=int)
    p.add_argument("--text-size", type=int)

    p = sub.add_parser("ui_image", help="ImageLabel from a Roblox asset id")
    p.add_argument("parent")
    p.add_argument("name")
    p.add_argument("--asset")
    p.add_argument("--position")
    p.add_argument("--size")
    p.add_argument("--scale")

    p = sub.add_parser("ui_list", help="UIListLayout that auto-arranges a container's children")
    p.add_argument("parent")
    p.add_argument("--direction")
    p.add_argument("--padding", type=int)
    p.add_argument("--halign")
    p.add_argument("--valign")

    p = sub.add_parser("play", help="start play-testing the game (client when possible, Run mode fallback)")
    p.add_argument("--mode", choices=["play", "run"])

    p = sub.add_parser("stop", help="stop the running play test")

    p = sub.add_parser("logs", help="read Studio output - errors and warnings from the play test")
    p.add_argument("--all", action="store_true", help="include info/print messages too")
    p.add_argument("--limit", type=int)
    p.add_argument("--since", type=float, help="unix timestamp floor (default: when the test started)")

    p = sub.add_parser("attr", help="read/set/clear Studio attributes on an instance")
    p.add_argument("path")
    p.add_argument("--set", action="append", metavar="K=V")
    p.add_argument("--clear", action="append", metavar="K")

    p = sub.add_parser("tag", help="add/remove CollectionService tags")
    p.add_argument("paths", nargs="+")
    p.add_argument("--add", action="append", metavar="TAG")
    p.add_argument("--remove", action="append", metavar="TAG")

    p = sub.add_parser("match", help="copy color/material/transparency from one part onto targets")
    p.add_argument("from_path")
    p.add_argument("to", nargs="+")

    p = sub.add_parser("scatter", help="scatter N copies of a template in a disc around it")
    p.add_argument("path")
    p.add_argument("--count", type=int, default=10)
    p.add_argument("--radius", type=float, default=20)
    p.add_argument("--y-jitter", dest="y_jitter", type=float, default=0)
    p.add_argument("--parent")
    p.add_argument("--name")

    p = sub.add_parser("terrain", help="fill or clear terrain (block or ball)")
    p.add_argument("--action", choices=["fill", "clear"], default="fill")
    p.add_argument("--shape", choices=["block", "ball"], default="block")
    p.add_argument("--position", required=True, help="x,y,z center")
    p.add_argument("--size", help="x,y,z (block)")
    p.add_argument("--radius", type=float, help="ball radius")
    p.add_argument("--material", default="Grass")

    p = sub.add_parser("search", help="search the Roblox Creator Store (models, meshes, images, audio)")
    p.add_argument("query")
    p.add_argument("--category", default="model", help="model|mesh|image|audio|video|plugin")
    p.add_argument("--limit", type=int)
    p.add_argument("--cursor", help="nextPageCursor from a previous search")

    p = sub.add_parser("info", help="details + thumbnail for one marketplace asset")

    p.add_argument("id")

    p = sub.add_parser("insert", help="insert a marketplace asset into the place")
    p.add_argument("id")
    p.add_argument("parent", nargs="?", default="Workspace")
    p.add_argument("--name")

    p = sub.add_parser("apply", help="apply an asset id to a property (Image, Texture, SoundId, MeshId...)")
    p.add_argument("id")
    p.add_argument("path")
    p.add_argument("prop")

    ns = ap.parse_args()
    cmd = ns.cmd
    timeout = ns.timeout

    if cmd == "ping":
        sys.exit(_out(call("ping", {}, timeout=max(timeout, 60))))
    if cmd == "debug":
        sys.exit(_out(call("debug", {}, timeout=max(timeout, 90))))
    if cmd == "status":
        sys.exit(_out(status()))
    if cmd == "exec":
        try:
            payload = json.loads(ns.json)
        except ValueError as exc:
            print("invalid JSON: %s" % exc, file=sys.stderr)
            sys.exit(2)
        if not isinstance(payload, dict) or "op" not in payload:
            print('JSON must be an object with an "op" key', file=sys.stderr)
            sys.exit(2)
        sys.exit(_out(call(payload["op"], payload.get("args") or {}, timeout)))
    if cmd == "lua":
        code = ns.code
        if ns.from_stdin or (code is None and not sys.stdin.isatty()):
            code = sys.stdin.read()
        if not code:
            print("no Lua code given (pass it as an argument or pipe it in)", file=sys.stderr)
            sys.exit(2)
        sys.exit(_out(call("run", {"code": code}, timeout=timeout)))
    if cmd == "list":
        args = {"path": ns.path}
        if ns.recursive:
            args["recursive"] = True
        if ns.max:
            args["max"] = ns.max
        sys.exit(_out(call("list", args, timeout)))
    if cmd == "tree":
        args = {"path": ns.path, "depth": ns.depth or 2}
        sys.exit(_out(call("tree", args, timeout)))
    if cmd == "read":
        args = {"path": ns.path}
        if ns.props:
            args["props"] = [p.strip() for p in ns.props.split(",") if p.strip()]
        sys.exit(_out(call("read", args, timeout), as_json=ns.as_json, raw_field="source"))
    if cmd == "find":
        args = {"scope": ns.scope}
        if ns.tag:
            args["tag"] = ns.tag
        else:
            args["query"] = ns.query
        if ns.cls:
            args["class"] = ns.cls
        if ns.max:
            args["max"] = ns.max
        if ns.exact:
            args["exact"] = True
        sys.exit(_out(call("find", args, timeout)))
    if cmd == "grep":
        args = {"pattern": ns.pattern, "scope": ns.scope}
        if ns.max:
            args["max"] = ns.max
        if ns.icase:
            args["caseSensitive"] = False
        sys.exit(_out(call("grep", args, timeout)))
    if cmd == "script":
        source = ns.source
        if source is None and not sys.stdin.isatty():
            source = sys.stdin.read()
        if source is None:
            print("pass the script source via stdin (heredoc/pipe) or --source", file=sys.stderr)
            sys.exit(2)
        sys.exit(_out(call("script", {
            "parent": ns.parent, "name": ns.name, "class": ns.cls, "mode": ns.mode, "source": source,
        }, timeout)))
    if cmd == "delete":
        sys.exit(_out(call("delete", {"paths": ns.paths}, timeout)))
    if cmd == "move":
        sys.exit(_out(call("move", {"path": ns.path, "parent": ns.parent}, timeout)))
    if cmd == "selection":
        args = {}
        if ns.clear:
            args["clear"] = True
        elif ns.set:
            args["set"] = [p.strip() for p in ns.set.split(",") if p.strip()]
        sys.exit(_out(call("selection", args, timeout)))
    if cmd == "search":
        if not _marketplace_via_plugin():
            err = None
            try:
                result = marketplace_search(ns.query, ns.category, ns.limit, ns.cursor)
            except Exception as exc:
                result, err = None, "marketplace search failed: %s" % exc
            if err is None:
                sys.exit(_out({"ok": True, "op": "search", "result": result}))
            sys.exit(_out({"ok": False, "op": "search", "error": err}))
        args = {"query": ns.query, "category": ns.category}
        if ns.limit:
            args["limit"] = ns.limit
        if ns.cursor:
            args["cursor"] = ns.cursor
        sys.exit(_out(call("search_assets", args, timeout=max(timeout, 180))))
    if cmd == "info":
        if not _marketplace_via_plugin():
            err = None
            try:
                result = marketplace_info(ns.id)
            except Exception as exc:
                result, err = None, "asset info failed: %s" % exc
            if err is None:
                sys.exit(_out({"ok": True, "op": "info", "result": result}))
            sys.exit(_out({"ok": False, "op": "info", "error": err}))
        sys.exit(_out(call("asset_info", {"id": ns.id}, timeout=max(timeout, 180))))
    if cmd == "insert":
        args = {"id": ns.id, "parent": ns.parent}
        if ns.name:
            args["name"] = ns.name
        sys.exit(_out(call("insert_asset", args, timeout=max(timeout, 300))))
    if cmd == "apply":
        sys.exit(_out(call("apply_asset", {"id": ns.id, "path": ns.path, "prop": ns.prop}, timeout=timeout)))
    if cmd == "say":
        sys.exit(_out(call("say", {"text": ns.text}, timeout)))
    if cmd == "turn":
        if ns.action == "begin":
            sys.exit(_out(call("turn_begin", {}, timeout)))
        args = {}
        if ns.note:
            args["note"] = ns.note
        sys.exit(_out(call("turn_end", args, timeout)))
    if cmd == "rotate":
        args = {"path": ns.path, "space": ns.space}
        if ns.absolute is not None:
            args["orientation"] = vec3(ns.absolute)
        else:
            args["axis"] = ns.axis
            args["degrees"] = ns.degrees
        sys.exit(_out(call("rotate", args, timeout)))
    if cmd == "face":
        sys.exit(_out(call("face", {"path": ns.path, "target": vec3(ns.target), "axis": ns.axis}, timeout)))
    if cmd == "shift":
        sys.exit(_out(call("shift", {"path": ns.path, "offset": vec3(ns.offset), "space": ns.space}, timeout)))
    if cmd == "scale":
        sys.exit(_out(call("scale", {"path": ns.path, "factor": ns.factor}, timeout)))
    if cmd == "duplicate":
        args = {"path": ns.path, "count": ns.count}
        if ns.offset:
            args["offset"] = vec3(ns.offset)
        if ns.parent:
            args["parent"] = ns.parent
        if ns.name:
            args["name"] = ns.name
        sys.exit(_out(call("duplicate", args, timeout)))
    if cmd == "group":
        args = {"paths": ns.paths, "name": ns.name}
        if ns.parent:
            args["parent"] = ns.parent
        sys.exit(_out(call("group", args, timeout)))
    if cmd == "pivot":
        args = {"path": ns.path}
        if ns.position:
            args["position"] = vec3(ns.position)
        if ns.orientation:
            args["orientation"] = vec3(ns.orientation)
        sys.exit(_out(call("set_pivot", args, timeout)))
    if cmd == "terrain":
        args = {"action": ns.action, "shape": ns.shape,
                "position": vec3(ns.position), "material": ns.material}
        if ns.shape == "block":
            if not ns.size:
                print("--size x,y,z is required for block", file=sys.stderr)
                sys.exit(2)
            args["size"] = vec3(ns.size)
        else:
            if ns.radius is None:
                print("--radius is required for ball", file=sys.stderr)
                sys.exit(2)
            args["radius"] = ns.radius
        sys.exit(_out(call("terrain", args, timeout)))
    if cmd == "place":
        args = {"path": ns.path, "position": vec3(ns.position)}
        if ns.orientation:
            args["orientation"] = vec3(ns.orientation)
        sys.exit(_out(call("place", args, timeout)))
    if cmd == "paint":
        args = {"paths": ns.paths}
        if ns.color:
            args["color"] = ns.color
        if ns.material:
            args["material"] = ns.material
        if ns.transparency is not None:
            args["transparency"] = ns.transparency
        if ns.reflectance is not None:
            args["reflectance"] = ns.reflectance
        sys.exit(_out(call("paint", args, timeout)))
    if cmd == "rename":
        sys.exit(_out(call("rename", {"path": ns.path, "name": ns.name}, timeout)))
    if cmd == "look":
        sys.exit(_out(call("look", {"path": ns.path, "distance": ns.distance}, timeout)))
    if cmd == "count":
        args = {"scope": ns.scope}
        if ns.cls:
            args["class"] = ns.cls
        sys.exit(_out(call("count", args, timeout)))
    if cmd == "undo":
        sys.exit(_out(call("undo", {}, timeout)))
    if cmd == "anchor":
        sys.exit(_out(call("anchor", {"paths": ns.paths, "anchored": not ns.off}, timeout)))
    if cmd == "collide":
        sys.exit(_out(call("collide", {"paths": ns.paths, "canCollide": not ns.off}, timeout)))
    if cmd == "light":
        args = {"path": ns.path, "type": ns.light_type}
        if ns.color:
            args["color"] = ns.color
        if ns.range is not None:
            args["range"] = ns.range
        if ns.brightness is not None:
            args["brightness"] = ns.brightness
        if ns.shadows:
            args["shadows"] = True
        sys.exit(_out(call("light", args, timeout)))
    if cmd == "sound":
        args = {"parent": ns.parent, "id": ns.id}
        if ns.volume is not None:
            args["volume"] = ns.volume
        if ns.loop:
            args["looped"] = True
        if ns.play:
            args["play"] = True
        if ns.name:
            args["name"] = ns.name
        sys.exit(_out(call("sound", args, timeout)))
    if cmd == "weld":
        sys.exit(_out(call("weld", {"paths": ns.paths}, timeout)))
    if cmd == "hitbox":
        args = {"path": ns.path, "padding": ns.padding}
        if ns.name:
            args["name"] = ns.name
        if ns.collide:
            args["canCollide"] = True
        sys.exit(_out(call("hitbox", args, timeout)))
    if cmd == "prompt":
        args = {"path": ns.path, "action": ns.action, "hold": ns.hold, "distance": ns.distance}
        if ns.object:
            args["object"] = ns.object
        sys.exit(_out(call("prompt", args, timeout)))
    if cmd == "particles":
        args = {"path": ns.path, "preset": ns.preset}
        if ns.rate is not None:
            args["rate"] = ns.rate
        if ns.color:
            args["color"] = ns.color
        sys.exit(_out(call("particles", args, timeout)))
    if cmd == "sign":
        args = {"text": ns.text}
        if ns.position:
            args["position"] = vec3(ns.position)
        if ns.parent:
            args["parent"] = ns.parent
        if ns.size:
            args["size"] = vec3(ns.size)
        if ns.name:
            args["name"] = ns.name
        sys.exit(_out(call("sign", args, timeout)))
    if cmd == "beam":
        args = {"from": getattr(ns, "from"), "to": ns.to}
        for k in ("color", "width", "curve", "name"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        sys.exit(_out(call("beam", args, timeout)))
    if cmd == "trail":
        args = {"path": ns.path}
        for k in ("color", "lifetime", "name"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        sys.exit(_out(call("trail", args, timeout)))
    if cmd == "explosion":
        args = {}
        if ns.position:
            args["position"] = vec3(ns.position)
        if ns.radius is not None:
            args["radius"] = ns.radius
        sys.exit(_out(call("explosion", args, timeout)))
    if cmd == "ui_screen":
        args = {"name": ns.name}
        if ns.parent:
            args["parent"] = ns.parent
        if ns.order is not None:
            args["order"] = ns.order
        sys.exit(_out(call("ui_screen", args, timeout)))
    if cmd == "ui_frame":
        args = {"parent": ns.parent, "name": ns.name}
        for k in ("position", "size", "anchor", "color", "transparency", "radius"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        if ns.clip:
            args["clip"] = True
        sys.exit(_out(call("ui_frame", args, timeout)))
    if cmd == "ui_label":
        args = {"parent": ns.parent, "name": ns.name}
        for k in ("text", "position", "size", "anchor", "color", "align", "font", "text_size"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        if ns.wrap:
            args["wrap"] = True
        sys.exit(_out(call("ui_label", args, timeout)))
    if cmd == "ui_button":
        args = {"parent": ns.parent, "name": ns.name}
        for k in ("text", "position", "size", "anchor", "color", "text_color", "radius", "font", "text_size"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        sys.exit(_out(call("ui_button", args, timeout)))
    if cmd == "ui_input":
        args = {"parent": ns.parent, "name": ns.name}
        for k in ("placeholder", "text", "position", "size", "color", "background", "radius", "text_size"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        sys.exit(_out(call("ui_input", args, timeout)))
    if cmd == "ui_image":
        args = {"parent": ns.parent, "name": ns.name}
        if ns.asset:
            args["asset"] = ns.asset
        for k in ("position", "size", "scale"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        sys.exit(_out(call("ui_image", args, timeout)))
    if cmd == "ui_list":
        args = {"parent": ns.parent}
        for k in ("direction", "padding", "halign", "valign"):
            v = getattr(ns, k, None)
            if v is not None:
                args[k] = v
        sys.exit(_out(call("ui_list", args, timeout)))
    if cmd == "play":
        args = {}
        if ns.mode:
            args["mode"] = ns.mode
        sys.exit(_out(call("play", args, timeout)))
    if cmd == "stop":
        sys.exit(_out(call("stop", {}, timeout)))
    if cmd == "logs":
        args = {"filter": "all"} if ns.all else {}
        if ns.limit is not None:
            args["limit"] = ns.limit
        if ns.since is not None:
            args["since"] = ns.since
        sys.exit(_out(call("logs", args, timeout)))
    if cmd == "attr":
        args = {"path": ns.path}
        if ns.set:
            parsed = {}
            for kv in ns.set:
                if "=" not in kv:
                    print("--set expects K=V", file=sys.stderr)
                    sys.exit(2)
                k, v = kv.split("=", 1)
                try:
                    v = int(v)
                except ValueError:
                    try:
                        v = float(v)
                    except ValueError:
                        if v == "true":
                            v = True
                        elif v == "false":
                            v = False
                parsed[k] = v
            args["set"] = parsed
        if ns.clear:
            args["clear"] = ns.clear
        sys.exit(_out(call("attributes", args, timeout)))
    if cmd == "tag":
        args = {"paths": ns.paths}
        if ns.add:
            args["add"] = ns.add
        if ns.remove:
            args["remove"] = ns.remove
        sys.exit(_out(call("tag", args, timeout)))
    if cmd == "match":
        sys.exit(_out(call("match", {"from": ns.from_path, "paths": ns.to}, timeout)))
    if cmd == "scatter":
        args = {"path": ns.path, "count": ns.count, "radius": ns.radius, "yJitter": ns.y_jitter}
        if ns.parent:
            args["parent"] = ns.parent
        if ns.name:
            args["name"] = ns.name
        sys.exit(_out(call("scatter", args, timeout)))
    if cmd == "waypoint":
        sys.exit(_out(call("waypoint", {"label": ns.label}, timeout)))


if __name__ == "__main__":
    main()
