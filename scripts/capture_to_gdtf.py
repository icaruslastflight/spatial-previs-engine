#!/usr/bin/env python3
"""
Capture ``.CaptureSymbol`` / ``.symdef`` -> GDTF ``.gdtf`` starter converter.

Capture Visualization AB ships fixture symbols as proprietary files:

* ``.symdef`` -- the historical form. Plain XML on disk, describing a symbol's
  DMX personality and (unlike ONYX) usually some geometry too.
* ``.CaptureSymbol`` -- the newer form. A ZIP archive holding a ``symbol.xml``
  (or similarly named XML) plus mesh assets under ``geometry/`` and thumbnails.

This script handles either shape transparently: if the input is a ZIP it pulls
the first ``*.xml`` entry, otherwise it treats the input as loose XML.

Like the ONYX converter, this script emits a starter GDTF: dummy Base -> Yoke
-> Head -> Beam geometry from the shared ``gdtf_writer`` module, plus the
channels the Capture personality actually declares. Capture's real geometry is
richer than ONYX's -- porting it faithfully into GDTF ``<Models>`` is a
follow-up, not the MVP.

Scope of this MVP
-----------------
* Dimmer, Pan, Tilt, RGB (ColorAdd_R/G/B) and CMY (ColorSub_C/M/Y).
* One DMX mode, 8-bit channels only.
* Dummy geometry only; Capture's <Geometry> block is skipped for now.

Everything marked ``TODO(reverse-engineer)`` is where the Capture symbol
schema is a best guess: their format is proprietary, so treat these as
anchors to refine against real samples. The parser is defensive -- a missing
tag falls back to a documented default rather than crashing.

Usage
-----
    python3 scripts/capture_to_gdtf.py input.CaptureSymbol -o output.gdtf
    python3 scripts/capture_to_gdtf.py input.symdef            # writes input.gdtf
    python3 scripts/capture_to_gdtf.py --inspect input.symdef  # dump the model
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Iterable

# scripts/ is on sys.path[0] when this file runs as a script.
from gdtf_writer import (
    DEFAULT_RANGES,
    ChannelModel,
    FixtureModel,
    build_description_xml,
    classify_attribute,
    print_inspection,
    write_gdtf,
)


# ---------------------------------------------------------------------------
# Phase 1: extraction
# ---------------------------------------------------------------------------
def read_capture_xml(symbol_path: Path) -> bytes:
    """Return the raw Capture symbol XML bytes.

    Accepts either the loose ``.symdef`` XML file or a ``.CaptureSymbol``
    ZIP archive. If the file starts with the ZIP magic ``PK\\x03\\x04`` we
    read it as an archive; otherwise we treat the bytes as XML directly.
    """
    if not symbol_path.exists():
        raise FileNotFoundError(f"Capture symbol not found: {symbol_path}")

    raw = symbol_path.read_bytes()
    if raw[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(symbol_path) as zf:
            # TODO(reverse-engineer): confirm the canonical XML entry name.
            # "symbol.xml" is a plausible convention; falling back to the
            # first XML keeps unusual archives working.
            xml_names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
            if not xml_names:
                raise ValueError(f"No XML entry inside {symbol_path}")
            preferred = next(
                (n for n in xml_names
                 if n.lower().endswith(("symbol.xml", "fixture.xml", "definition.xml"))),
                xml_names[0],
            )
            return zf.read(preferred)
    return raw


# ---------------------------------------------------------------------------
# Phase 2: parse & map
# ---------------------------------------------------------------------------
# Capture's schema is not published. Every XPath below is a best guess drawn
# from public forum threads and third-party inspections; verify against a
# real sample before shipping. The parser tries several spellings so small
# dialect drift stays parseable.

_SYMBOL_ROOT_CANDIDATES = (
    ".",
    "./Symbol",
    "./Fixture",
    "./FixtureDefinition",
    "./Definition",
)
_NAME_CANDIDATES = ("Name", "@Name", "FixtureName", "Model", "@Model")
_MANUFACTURER_CANDIDATES = ("Manufacturer", "@Manufacturer", "Vendor", "Maker")
_SHORT_NAME_CANDIDATES = ("ShortName", "@ShortName", "Abbreviation")
_MODE_CONTAINER_CANDIDATES = (
    ".//DMXModes/DMXMode",
    ".//Modes/Mode",
    ".//DMXMode",
    ".//Mode",
)
_MODE_NAME_CANDIDATES = ("Name", "@Name", "Label", "@Label")

# Within a mode, the per-channel elements. Capture personalities have used
# a "Function" element as well as the more obvious "Channel".
_CHANNEL_CONTAINER_CANDIDATES = (
    ".//Channels/Channel",
    ".//Channel",
    ".//Functions/Function",
    ".//Function",
    ".//Parameter",
)


def _find_first_text(node: ET.Element, candidates: Iterable[str]) -> str | None:
    for path in candidates:
        if "@" in path:
            elem_path, _, attr = path.rpartition("@")
            elem_path = elem_path.rstrip("/")
            target = node if not elem_path or elem_path == "." else node.find(elem_path)
            if target is not None and attr in target.attrib:
                value = target.attrib[attr].strip()
                if value:
                    return value
            continue
        elem = node.find(path)
        if elem is not None and elem.text and elem.text.strip():
            return elem.text.strip()
    return None


def _parse_int(value: str | None, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value.strip())
    except ValueError:
        return default


def _parse_float(value: str | None, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(value.strip())
    except ValueError:
        return default


def parse_capture(xml_bytes: bytes, mode_filter: str | None = None) -> FixtureModel:
    """
    Turn Capture symbol XML bytes into a :class:`FixtureModel`.

    Capture symbols typically declare multiple DMX modes (Basic / Extended /
    16-bit). ``mode_filter`` picks one by (case-insensitive substring) name;
    absent, the first mode wins -- matching how the console defaults.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"Capture XML is malformed: {exc}") from exc

    symbol_node: ET.Element | None = None
    for candidate in _SYMBOL_ROOT_CANDIDATES:
        symbol_node = root if candidate == "." else root.find(candidate)
        if symbol_node is not None:
            break
    if symbol_node is None:
        symbol_node = root

    fixture = FixtureModel(source_format="Capture symbol")
    fixture.name = _find_first_text(symbol_node, _NAME_CANDIDATES) or fixture.name
    fixture.manufacturer = (
        _find_first_text(symbol_node, _MANUFACTURER_CANDIDATES) or fixture.manufacturer
    )
    fixture.short_name = (
        _find_first_text(symbol_node, _SHORT_NAME_CANDIDATES)
        or fixture.name[:8].upper().replace(" ", "")
        or fixture.short_name
    )

    # Locate every candidate mode container, then pick one.
    mode_nodes: list[ET.Element] = []
    for path in _MODE_CONTAINER_CANDIDATES:
        hits = symbol_node.findall(path)
        if hits:
            mode_nodes = hits
            break

    if not mode_nodes:
        # Some Capture personalities inline channels directly under the
        # symbol root without an explicit <Mode> wrapper. Fall back to the
        # symbol node itself.
        mode_nodes = [symbol_node]

    chosen_mode: ET.Element | None = None
    if mode_filter:
        needle = mode_filter.lower()
        for m in mode_nodes:
            mode_label = _find_first_text(m, _MODE_NAME_CANDIDATES) or ""
            if needle in mode_label.lower():
                chosen_mode = m
                break
        if chosen_mode is None:
            raise ValueError(
                f"No mode matching {mode_filter!r}; available: "
                + ", ".join(
                    _find_first_text(m, _MODE_NAME_CANDIDATES) or "(unnamed)"
                    for m in mode_nodes
                )
            )
    else:
        chosen_mode = mode_nodes[0]

    fixture.mode_name = (
        _find_first_text(chosen_mode, _MODE_NAME_CANDIDATES) or fixture.mode_name
    )

    channel_nodes: list[ET.Element] = []
    for path in _CHANNEL_CONTAINER_CANDIDATES:
        hits = chosen_mode.findall(path)
        if hits:
            channel_nodes = hits
            break

    if not channel_nodes:
        raise ValueError(
            "No channel elements found in Capture XML; the symbol XPath "
            "likely needs updating for this dialect."
        )

    for idx, ch in enumerate(channel_nodes, start=1):
        # Capture channels usually carry a "Parameter"/"Attribute"/"Name"
        # tag with the human name ("Pan", "Dimmer", "CyanCMY", ...).
        raw_name = (
            _find_first_text(ch, ("Parameter", "@Parameter", "Attribute",
                                  "@Attribute", "Name", "@Name", "Function"))
            or f"Channel{idx}"
        )
        classification = classify_attribute(raw_name)
        if classification is None:
            continue
        attribute, unit = classification

        # TODO(reverse-engineer): confirm Capture's offset naming. Public
        # samples have used "Offset", "Address", "Byte" for 8-bit and
        # "OffsetFine"/"ByteFine" for the 16-bit companion.
        offset = _parse_int(
            _find_first_text(ch, ("Offset", "@Offset", "Address", "@Address",
                                  "Byte", "@Byte")),
            default=idx,
        )
        fine_offset_raw = _find_first_text(
            ch, ("OffsetFine", "@OffsetFine", "FineOffset", "@FineOffset",
                 "ByteFine", "@ByteFine")
        )
        fine_offset = _parse_int(fine_offset_raw, default=0) or None

        default_from, default_to, default_unit = DEFAULT_RANGES[attribute]
        physical_from = _parse_float(
            _find_first_text(ch, ("PhysicalFrom", "@PhysicalFrom", "Min",
                                  "@Min", "MinValue")),
            default=default_from,
        )
        physical_to = _parse_float(
            _find_first_text(ch, ("PhysicalTo", "@PhysicalTo", "Max", "@Max",
                                  "MaxValue")),
            default=default_to,
        )
        physical_unit = unit or default_unit
        default_dmx = _parse_int(
            _find_first_text(ch, ("Default", "@Default", "Home", "@Home",
                                  "InitialValue")),
            default=0,
        )

        fixture.channels.append(ChannelModel(
            name=raw_name,
            attribute=attribute,
            offset=offset,
            fine_offset=fine_offset,
            physical_from=physical_from,
            physical_to=physical_to,
            physical_unit=physical_unit,
            default_dmx=default_dmx,
        ))

    if not fixture.channels:
        raise ValueError(
            "Capture symbol parsed but no supported channels remained after "
            "classification (Dimmer/Pan/Tilt/RGB/CMY)."
        )

    fixture.dmx_footprint = fixture.compute_footprint()
    return fixture


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert a Capture Visualization symbol to GDTF."
    )
    parser.add_argument("input", type=Path,
                        help="Path to a .CaptureSymbol or .symdef file.")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="Destination .gdtf path (default: alongside input).")
    parser.add_argument("--mode", default=None,
                        help="Pick a specific DMX mode by (substring) name.")
    parser.add_argument("--inspect", action="store_true",
                        help="Parse and dump the mapped model; don't write GDTF.")
    args = parser.parse_args(argv)

    try:
        xml_bytes = read_capture_xml(args.input)
        fixture = parse_capture(xml_bytes, mode_filter=args.mode)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.inspect:
        print_inspection(fixture)
        return 0

    output_path = args.output or args.input.with_suffix(".gdtf")
    description_xml = build_description_xml(fixture)
    try:
        write_gdtf(fixture, description_xml, output_path)
    except OSError as exc:
        print(f"error writing {output_path}: {exc}", file=sys.stderr)
        return 1

    print(f"wrote {output_path} ({len(fixture.channels)} channels, "
          f"{fixture.dmx_footprint} DMX slots)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
