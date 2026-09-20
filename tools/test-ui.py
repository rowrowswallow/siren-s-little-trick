#!/usr/bin/env python3
"""Browser acceptance checks for the real Siren UI (development only).

Run the server first: node tools/serve.mjs 4173
Then: python tools/test-ui.py --screenshots

Uses two independent, fresh browser contexts. The denied route exercises the
actual browser rejection and five rhythm phrases. The synthetic microphone
route supplies an actual Web Audio MediaStream, follows the published melody
events, and leaves one phrase silent. No internal game functions are invoked.
This checks desktop Chromium; a real phone and human microphone remain needed.
"""

import argparse
import asyncio
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import TimeoutError as PlaywrightTimeout, async_playwright


VIEWPORTS = [("desktop", 1440, 900), ("landscape", 844, 390), ("portrait", 390, 844)]
EVENTS = ["state:change", "melody:phraseStart", "attempt:countdown", "attempt:start",
          "attempt:end", "ship:in", "ship:wrecked", "phrase:result", "game:finale",
          "melody:replay", "notice", "error"]
FORBIDDEN_COPY = ["共鸣度", "评级", "金句", "你跑调了", "再大声一点", "别害羞"]
ACTION_LABELS = {
    "start": re.compile("让她开口"),
    "replay": re.compile("重听"),
    "share": re.compile("分享|生成.*卡|留下.*卡|海上.*明信片|纪念"),
    "restart": re.compile("再来一局"),
    "abort": re.compile("回到首页|返回首页|离开|回到海岸"),
}

MIC_SCRIPT = """(() => {
  window.__qaMicrophone = null;
  if (!navigator.mediaDevices) return;
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {value: async () => {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    oscillator.type = 'sine'; gain.gain.value = 0;
    oscillator.connect(gain); gain.connect(destination); oscillator.start();
    await context.resume();
    window.__qaMicrophone = {context, oscillator, gain, destination};
    return destination.stream;
  }});
})();"""

OBSERVE_SCRIPT = """({events, synthetic}) => {
  const qa = window.__uiQA = {events: [], notes: [], voiced: 0, unvoiced: 0,
    countdowns: [], tapDue: [], starts: [], silence: [], snapshots: []};
  events.forEach(type => Siren.on(type, payload => {
    const now = performance.now();
    qa.events.push({type, payload, at: now});
    if (type === 'melody:phraseStart') qa.notes = payload.notes;
    if (type === 'attempt:countdown') qa.countdowns.push(payload.from);
    if (type === 'attempt:end' && payload.reason === 'silence') qa.silence.push(Siren.getState().phraseIndex);
    if (type === 'attempt:start') {
      qa.starts.push(payload.phraseIndex);
      if (Siren.getState().phase === 'RHYTHM_FALLBACK') {
        qa.tapDue = qa.notes.map(note => now + 500 + note.startMs);
      }
      if (synthetic && window.__qaMicrophone && payload.phraseIndex !== 2) {
        const {context, oscillator, gain} = window.__qaMicrophone;
        const base = context.currentTime + .065;
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(0, context.currentTime);
        qa.notes.forEach(note => {
          const at = base + note.startMs / 1000;
          oscillator.frequency.setValueAtTime(440 * Math.pow(2, (note.midi - 69) / 12), at);
          gain.gain.setValueAtTime(.24, at);
          gain.gain.setValueAtTime(0, at + note.durationMs / 1000 * .86);
        });
      }
    }
  }));
  Siren.on('attempt:pitch', payload => { if (payload.voiced) qa.voiced++; else qa.unvoiced++; });
}"""

LAYOUT_SCRIPT = """() => {
  const visible = element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' &&
      style.display !== 'none' && element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  };
  const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visible).map(el => {
    const box = el.getBoundingClientRect();
    return {text: (el.innerText || el.getAttribute('aria-label') || '').trim(),
      action: el.dataset.action, x: box.x, y: box.y, width: box.width, height: box.height,
      clipped: box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1,
      disabled: !!el.disabled};
  });
  const brokenImages = [...document.images].filter(el => !el.complete || el.naturalWidth === 0).map(el => el.src);
  const counters = [...document.querySelectorAll('#ship-number, #phrase-number, #result-number, #share-number')]
    .filter(visible).map(el => ({id: el.id, text: el.textContent.trim()}));
  return {width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight, text: document.body.innerText,
    controls, counters, brokenImages, state: Siren.getState()};
}"""


async def click_action(page, name, required=True):
    # An optional control can go away between the visibility check and the click: replay is
    # only live during LISTEN. Treat that race as "not clicked" so the caller can retry on the
    # next phrase, instead of failing a run for a timing artifact of the harness.
    async def attempt(locator):
        if not await locator.count():
            return False
        try:
            await locator.first.click(timeout=2500)
        except PlaywrightTimeout:
            if required:
                raise
            return False
        return True

    if await attempt(page.locator('[data-action="' + name + '"]').filter(visible=True)):
        return True
    label = ACTION_LABELS.get(name)
    if label and await attempt(page.get_by_role("button", name=label).filter(visible=True)):
        return True
    if required:
        raise AssertionError("No visible action: " + name)
    return False


async def snapshot(page, report, output, name, screenshots):
    await page.wait_for_timeout(120)
    data = await page.evaluate(LAYOUT_SCRIPT)
    data["name"] = name
    report["layouts"].append(data)
    if data["scrollWidth"] > data["width"] + 1:
        report["failures"].append(name + ": horizontal document overflow")
    if data["brokenImages"]:
        report["failures"].append(name + ": broken images " + str(data["brokenImages"]))
    if len(data["counters"]) > 1:
        report["failures"].append(name + ": multiple simultaneous boat counters " + str(data["counters"]))
    for counter in data["counters"]:
        if counter["id"] in ("result-number", "share-number") and counter["text"] != str(data["state"]["shipsWrecked"]):
            report["failures"].append(name + ": result/share boat count differs from backend")
    for control in data["controls"]:
        if control["clipped"]:
            report["failures"].append(name + ": clipped control " + control["text"])
    for phrase in FORBIDDEN_COPY:
        if phrase in data["text"]:
            report["failures"].append(name + ": forbidden evaluation copy " + phrase)
    if screenshots:
        await page.screenshot(path=str(output / (name + ".png")), animations="disabled")


async def viewport_snapshots(page, report, output, name, screenshots):
    previous = page.viewport_size
    for device, width, height in VIEWPORTS:
        await page.set_viewport_size({"width": width, "height": height})
        await snapshot(page, report, output, name + "-" + device, screenshots)
    if previous:
        await page.set_viewport_size(previous)


async def scenario(browser, args, mode):
    output = args.output
    report = {"mode": mode, "failures": [], "errors": [], "consoleWarnings": [],
              "requestsFailed": [], "httpErrors": [], "externalRequests": [], "layouts": [], "events": []}
    synthetic = mode == "microphone"
    context = await browser.new_context(viewport={"width": 1440 if synthetic else 844,
                                                  "height": 900 if synthetic else 390},
                                        has_touch=not synthetic, reduced_motion="reduce")
    if synthetic:
        await context.add_init_script(MIC_SCRIPT)
    await context.add_init_script("try {localStorage.setItem('siren.seed', '4821');} catch (_) {}")
    page = await context.new_page()
    origin = urlparse(args.url).netloc
    page.on("pageerror", lambda error: report["errors"].append(str(error)))
    page.on("console", lambda msg: report["consoleWarnings"].append(msg.text)
            if msg.type in ("error", "warning") else None)
    page.on("requestfailed", lambda req: report["requestsFailed"].append({"url": req.url, "error": req.failure}))
    page.on("response", lambda response: report["httpErrors"].append({"url": response.url, "status": response.status})
            if response.status >= 400 and not response.url.endswith("favicon.ico") else None)
    page.on("request", lambda req: report["externalRequests"].append(req.url)
            if urlparse(req.url).scheme in ("http", "https") and urlparse(req.url).netloc != origin else None)
    try:
        await page.goto(args.url, wait_until="networkidle")
        await page.wait_for_function("window.Siren && Siren.getState().phase === 'HOME'", timeout=10000)
        await page.evaluate(OBSERVE_SCRIPT, {"events": EVENTS, "synthetic": synthetic})
        await viewport_snapshots(page, report, output, mode + "-home", args.screenshots)
        await click_action(page, "start")
        captured = set()
        last_event = 0
        replay_tested = False
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            data = await page.evaluate("""last => ({state: Siren.getState(), now: performance.now(),
                due: window.__uiQA.tapDue[0], events: window.__uiQA.events.slice(last),
                count: window.__uiQA.events.length})""", last_event)
            state = data["state"]
            last_event = data["count"]
            report["events"].extend(data["events"])
            key = state["subPhase"] if state["phase"] in ("LEARN_LOOP", "RHYTHM_FALLBACK") else state["phase"]
            if key and key not in captured and key not in ("BOOT", "PERM_REQUEST", "ANALYZE"):
                captured.add(key)
                await snapshot(page, report, output, mode + "-" + key.lower(), args.screenshots)
                if synthetic and key in ("LISTEN", "RECORD", "PHRASE_RESULT"):
                    await viewport_snapshots(page, report, output, mode + "-" + key.lower(), args.screenshots)
                print(mode + ": " + key, flush=True)
            if synthetic and state["subPhase"] == "LISTEN" and not replay_tested:
                replay_tested = await click_action(page, "replay", required=False)
                if replay_tested:
                    report["replayClicked"] = True
            if not synthetic and state["subPhase"] == "RECORD" and data["due"] is not None and data["now"] >= data["due"]:
                await page.evaluate("window.__uiQA.tapDue.shift()")
                target = page.locator('#tap-target, [data-action="tap"], [data-action="rhythm"]')
                if await target.count() and await target.first.is_visible():
                    if await target.first.is_disabled():
                        raise AssertionError("Rhythm tap target is disabled during RECORD")
                    await target.first.click(no_wait_after=True)
                else:
                    await page.mouse.click(page.viewport_size["width"] * .62, page.viewport_size["height"] * .80)
            if state["phase"] == "SHARE_CARD":
                break
            if state["phase"] == "RESULT":
                # Some backends expose a short RESULT transition, others wait for a share action.
                await page.wait_for_timeout(500)
                if await page.evaluate("Siren.getState().phase") == "RESULT":
                    if not await click_action(page, "share", required=False):
                        report["failures"].append("RESULT has no share action")
                        break
            await page.wait_for_timeout(35)
        else:
            report["failures"].append("Game did not finish within " + str(args.timeout) + " seconds")

        report["finalState"] = await page.evaluate("Siren.getState()")
        report["trace"] = await page.evaluate("""({events: __uiQA.events, voiced: __uiQA.voiced,
            unvoiced: __uiQA.unvoiced, starts: __uiQA.starts, silence: __uiQA.silence})""")
        events = report["trace"]["events"]
        phrases = [event["payload"] for event in events if event["type"] == "phrase:result"]
        report["phraseResults"] = phrases
        if [item["phraseIndex"] for item in phrases] != list(range(5)):
            report["failures"].append("Expected exactly five ordered phrase results")
        if len([event for event in events if event["type"] == "ship:in"]) != 100:
            report["failures"].append("Expected all 100 actual ship entry events")
        ship_ids = [event["payload"]["id"] for event in events if event["type"] == "ship:in"]
        if len(set(ship_ids)) != len(ship_ids):
            report["failures"].append("Duplicate ship IDs emitted during a run")
        if sum(item["newWrecked"] for item in phrases) != report["finalState"]["shipsWrecked"]:
            report["failures"].append("Final boat count differs from sum of phrase results")
        if len([event for event in events if event["type"] == "ship:wrecked"]) != report["finalState"]["shipsWrecked"]:
            report["failures"].append("Final boat count differs from actual wrecked ship events")
        if not report["finalState"]["shipsWrecked"]:
            report["failures"].append("Supplied musical input failed to attract any ships")
        required = {"LISTEN", "COUNTDOWN", "RECORD", "PULL", "PHRASE_RESULT", "FINALE"}
        if not required.issubset(captured):
            report["failures"].append("Missing displayed states: " + str(sorted(required - captured)))
        if synthetic and report["trace"]["voiced"] < 5:
            report["failures"].append("Synthetic microphone produced too few actual voiced pitch events")
        if synthetic and 2 not in report["trace"]["silence"]:
            report["failures"].append("The intentionally silent phrase did not finish as silence")
        if synthetic and not report.get("replayClicked"):
            report["failures"].append("Replay could not be exercised via the UI")
        for index, event in enumerate(events):
            if event["type"] not in ("melody:phraseStart", "melody:replay"):
                continue
            end_ms = max((note["startMs"] + note["durationMs"] for note in event["payload"]["notes"]), default=0)
            next_state = next((later for later in events[index + 1:] if later["type"] == "state:change" and
                               (later["payload"]["subPhase"] == "COUNTDOWN" if event["type"] == "melody:phraseStart"
                                else later["payload"]["phase"] == "RESULT")), None)
            if next_state and next_state["at"] - event["at"] < end_ms - 80:
                report["failures"].append(event["type"] + " advanced UI before the scheduled notes finished")
        if not synthetic and not any(event["type"] == "error" and event["payload"].get("code") == "MIC_DENIED" for event in events):
            report["failures"].append("Fresh context did not exercise microphone denial")
        await viewport_snapshots(page, report, output, mode + "-result", args.screenshots)
        await click_action(page, "share")
        await viewport_snapshots(page, report, output, mode + "-share", args.screenshots)
        if report["finalState"]["phase"] == "SHARE_CARD":
            body = await page.locator("body").inner_text()
            if "截屏" not in body and "截图" not in body:
                report["failures"].append("Share view lacks screenshot instruction")
        await click_action(page, "close-share")
        await page.wait_for_timeout(160)
        report["afterCloseShare"] = await page.evaluate(LAYOUT_SCRIPT)
        restart_action = "new-melody" if synthetic else "restart"
        if await click_action(page, restart_action):
            await page.wait_for_function("Siren.getState().shipsSpawned === 0 && Siren.getState().shipsWrecked === 0", timeout=5000)
            restarted = await page.evaluate("Siren.getState()")
            report["restartState"] = restarted
            if restarted["shipsSpawned"] != 0 or restarted["shipsWrecked"] != 0:
                report["failures"].append("Restart did not reset boat counters")
            if synthetic and restarted["seed"] == report["finalState"]["seed"]:
                report["failures"].append("New melody did not change seed")
            if not synthetic and restarted["seed"] != report["finalState"]["seed"]:
                report["failures"].append("Restart unexpectedly changed melody")
            if await click_action(page, "abort"):
                await page.wait_for_function("Siren.getState().phase === 'HOME'", timeout=2500)
                report["abortState"] = await page.evaluate("Siren.getState()")
    except Exception as error:
        report["failures"].append(type(error).__name__ + ": " + str(error))
        if args.screenshots:
            await page.screenshot(path=str(output / (mode + "-failure.png")))
    finally:
        if report["errors"]:
            report["failures"].append("Uncaught browser errors: " + str(report["errors"]))
        listener_errors = [line for line in report["consoleWarnings"] if "listener error" in line]
        if listener_errors:
            report["failures"].append("Frontend event listener errors: " + str(listener_errors))
        if report["externalRequests"]:
            report["failures"].append("External network requests: " + str(report["externalRequests"]))
        if report["httpErrors"] or report["requestsFailed"]:
            report["failures"].append("Failed resources: " + str(report["httpErrors"] + report["requestsFailed"]))
        (output / (mode + ".json")).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        await context.close()
    return report


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:4173")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "output" / "ui-validation")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--screenshots", action="store_true")
    parser.add_argument("--mode", choices=["all", "fallback", "microphone"], default="all")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=[
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"])
        modes = ["fallback", "microphone"] if args.mode == "all" else [args.mode]
        reports = await asyncio.gather(*(scenario(browser, args, mode) for mode in modes))
        await browser.close()
    lines = ["# Frontend browser acceptance report", "", "Real Chromium state-machine runs; no internal state mutation.", "",
             "Microphone route uses a synthetic Web Audio stream. Physical device, permissions, and human singing require manual verification.", ""]
    failures = 0
    for report in reports:
        failures += len(report["failures"])
        lines += ["## " + report["mode"], "", "Result: " + ("PASS" if not report["failures"] else "FAIL"), ""]
        lines += ["- " + failure for failure in report["failures"]]
        lines += ["", "Observed " + str(len(report.get("phraseResults", []))) + " phrase results.", ""]
    (args.output / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"failures": failures, "report": str(args.output / "REPORT.md")}, ensure_ascii=False), flush=True)
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
