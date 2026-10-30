#!/usr/bin/env python3
"""docs/guide.html → docs/CUTROAD_사용가이드.png (Playwright + Chromium 필요)
   python3 scripts/guide.py [Chromium 경로]"""
import asyncio, os, sys
from playwright.async_api import async_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
async def main():
    async with async_playwright() as p:
        kw = {}
        if len(sys.argv) > 1:
            kw = {"executable_path": sys.argv[1], "args": ["--no-sandbox", "--single-process", "--no-zygote", "--use-gl=angle", "--use-angle=swiftshader", "--in-process-gpu"]}
        b = await p.chromium.launch(**kw)
        pg = await b.new_page(viewport={"width": 1200, "height": 800}, device_scale_factor=2)
        await pg.goto("file://" + os.path.join(ROOT, "docs", "guide.html"))
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=os.path.join(ROOT, "docs", "CUTROAD_사용가이드.png"), full_page=True)
        await b.close()
asyncio.run(main())
