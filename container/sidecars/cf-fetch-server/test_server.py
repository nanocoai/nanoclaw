#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import pathlib
import sys
import types
import unittest
from typing import Any


SERVER_PATH = pathlib.Path(__file__).with_name("server.py")


def load_server_module():
    spec = importlib.util.spec_from_file_location("cf_fetch_server", SERVER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load cf-fetch-server module spec")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProxyParsingHealthzContract(unittest.TestCase):
    def test_proxy_credentials_are_redacted_from_browser_arg_and_health(self) -> None:
        server = load_server_module()
        marker = "sample-" + "secret"
        raw = "http://" + "sample-user" + ":" + marker + "@p.webshare.io:80"

        parsed = server._parse_proxy_url(raw)

        self.assertEqual(parsed["browser_arg"], "http://p.webshare.io:80")
        self.assertNotIn(marker, server._redact_proxy(parsed))


class ContainerDefaultsContract(unittest.TestCase):
    def test_defaults_bind_to_loopback(self) -> None:
        server = load_server_module()

        self.assertEqual(server.HOST, "127.0.0.1")

    def test_malformed_proxy_falls_back_without_crash(self) -> None:
        server = load_server_module()

        self.assertIsNone(server._parse_proxy_url("not-a-url"))


class NodriverLaunchContract(unittest.TestCase):
    def test_browser_launch_disables_chromium_sandbox_for_container(self) -> None:
        server = load_server_module()
        calls: list[dict[str, Any]] = []

        class FakeDisplay:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def start(self) -> None:
                pass

            def stop(self) -> None:
                pass

        class FakeBrowser:
            stopped = False

            async def get(self, _url: str) -> None:
                return None

            async def close(self) -> None:
                return None

        async def fake_start(**kwargs: Any) -> FakeBrowser:
            calls.append(kwargs)
            return FakeBrowser()

        original_nodriver = sys.modules.get("nodriver")
        original_pyvirtualdisplay = sys.modules.get("pyvirtualdisplay")
        fake_nodriver = types.ModuleType("nodriver")
        setattr(fake_nodriver, "start", fake_start)
        fake_pyvirtualdisplay = types.ModuleType("pyvirtualdisplay")
        setattr(fake_pyvirtualdisplay, "Display", FakeDisplay)
        sys.modules["nodriver"] = fake_nodriver
        sys.modules["pyvirtualdisplay"] = fake_pyvirtualdisplay
        try:
            state = server._BrowserState()
            state.start()
            state.stop()
        finally:
            if original_nodriver is None:
                sys.modules.pop("nodriver", None)
            else:
                sys.modules["nodriver"] = original_nodriver
            if original_pyvirtualdisplay is None:
                sys.modules.pop("pyvirtualdisplay", None)
            else:
                sys.modules["pyvirtualdisplay"] = original_pyvirtualdisplay

        self.assertEqual(calls[0]["sandbox"], False)

    def test_proxy_launch_keeps_loopback_on_implicit_direct_path(self) -> None:
        server = load_server_module()
        calls: list[dict[str, Any]] = []

        class FakeBrowser:
            stopped = False

            async def get(self, _url: str) -> None:
                return None

            async def close(self) -> None:
                return None

        async def fake_start(**kwargs: Any) -> FakeBrowser:
            calls.append(kwargs)
            return FakeBrowser()

        class FakeDisplay:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def start(self) -> None:
                pass

            def stop(self) -> None:
                pass

        original_nodriver = sys.modules.get("nodriver")
        original_pyvirtualdisplay = sys.modules.get("pyvirtualdisplay")
        original_proxy = os.environ.get("HTTP_PROXY_URL")
        original_xvfb = os.environ.get("NODRIVER_USE_XVFB")
        fake_nodriver = types.ModuleType("nodriver")
        setattr(fake_nodriver, "start", fake_start)
        fake_pyvirtualdisplay = types.ModuleType("pyvirtualdisplay")
        setattr(fake_pyvirtualdisplay, "Display", FakeDisplay)
        sys.modules["nodriver"] = fake_nodriver
        sys.modules["pyvirtualdisplay"] = fake_pyvirtualdisplay
        proxy_key = "HTTP_PROXY_URL"
        proxy_url = "http://" + "user" + ":" + "pass" + "@p.webshare.io:80"
        os.environ[proxy_key] = proxy_url
        os.environ["NODRIVER_USE_XVFB"] = "0"
        try:
            state = server._BrowserState()
            state.start()
            state.stop()
        finally:
            if original_nodriver is None:
                sys.modules.pop("nodriver", None)
            else:
                sys.modules["nodriver"] = original_nodriver
            if original_pyvirtualdisplay is None:
                sys.modules.pop("pyvirtualdisplay", None)
            else:
                sys.modules["pyvirtualdisplay"] = original_pyvirtualdisplay
            if original_proxy is None:
                os.environ.pop("HTTP_PROXY_URL", None)
            else:
                os.environ["HTTP_PROXY_URL"] = original_proxy
            if original_xvfb is None:
                os.environ.pop("NODRIVER_USE_XVFB", None)
            else:
                os.environ["NODRIVER_USE_XVFB"] = original_xvfb

        browser_args = calls[0]["browser_args"]
        self.assertIn("--proxy-server=http://p.webshare.io:80", browser_args)
        self.assertNotIn("--proxy-bypass-list=<-loopback>", browser_args)


if __name__ == "__main__":
    unittest.main()
