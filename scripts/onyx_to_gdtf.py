#!/usr/bin/env python3
"""
ONYX ``.Fixture`` -> GDTF ``.gdtf`` starter converter.

Obsidian ONYX ships fixture personalities as ``.Fixture`` files: ZIP archives
holding a proprietary AtlaBase CEF (Common Export Format) XML plus the odd
thumbnail. They describe what DMX values do (0..255 -> "pan 0..540 deg",
"dimmer 0..100 %", etc.) but they contain **no 3D geometry**.

GDTF (DIN SPEC 15800:2022-02) is the open interchange format previz tools such
as this project's ``GDTFParser`` consume. It is also a ZIP archive, keyed on
``description.xml``, and it *requires* a physical geometry hierarchy
(Base -> Yoke -> Head -> Beam) to be useful.

This script is the ONYX-specific *parser* half. The shared writer half --
attribute definitions, dummy geometry, DMX mode, packaging -- lives in
``gdtf_writer.py`` and is used identically by ``capture_to_gdtf.py``.

Scope of this MVP
-----------------
* Dimmer, Pan, Tilt, RGB (ColorAdd_R/G/B) and CMY (ColorSub_C/M/Y).
* One DMX mode, 8-bit channels only (a ``FineOffset`` sibling is preserved
  when present but not yet promoted to a second DMX byte on output).

Everything marked ``TODO(reverse-engineer)`` is where the AtlaBase XPath is a
best guess: ONYX's schema is not public, so treat these as anchors to refine
against real ``.Fixture`` samples. The parser is defensive -- a missing tag
falls back to a documented default rather than crashing.

Usage
-----
    python3 scripts/onyx_to_gdtf.py input.Fixture -o output.gdtf
    python3 scripts/onyx_to_gdtf.py input.Fixture           # writes input.gdtf
    python3 scripts/onyx_to_gdtf.py --inspect input.Fixture # dump parsed model
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Iterable

# `python3 scripts/onyx_to_gdtf.py` puts scripts/ on sys.path[0], so this
# resolves without a package or PYTHONPATH tweak.
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
def read_onyx_xml(fixture_path: Path) -> bytes:
    """Return the raw AtlaBase XML bytes from a ``.Fixture`` archive.

    ONYX ships one XML per archive but does not commit to a filename; picking
    "the first ``*.xml`` entry" is a pragmatic default that has held on every
    sample seen so far. If a real archive turns up with sidecar XMLs (a
    version manifest, say) tighten this to match on a known root element
    instead.
    """
    if not fixture_path.exists():
        raise FileNotFoundError(f"ONYX fixture not found: {fixture_path}")
    if not zipfile.is_zipfile(fixture_path):
        raise ValueError(
            f"{fixture_path} is not a ZIP archive -- is this really a "
            f".Fixture file?"
        )
    with zipfile.ZipFile(fixture_path) as zf:
        xml_names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not xml_names:
            raise ValueError(f"No XML entry inside {fixture_path}")
        # TODO(reverse-engineer): if ONYX ever emits >1 XML, filter by root
        # element name (probably "Fixture" or "AtlaBaseExport") instead of
        # taking the first hit.
        return zf.read(xml_names[0])


# ---------------------------------------------------------------------------
# Phase 2: parse & map
# ---------------------------------------------------------------------------
# The AtlaBase CEF schema is proprietary. Every XPath below is a *best guess*
# derived from public ONYX exports and forum reports; verify against a real
# sample before shipping. The parser reads several plausible tag spellings
# so small dialect drift does not blow the run up.

_FIXTURE_ROOT_CANDIDATES = (
    ".",
    "./Fixture",
    "./FixtureDefinition",
    "./Personality",
)
_NAME_CANDIDATES = ("Name", "FixtureName", "Model", "@Name", "@name")
_MANUFACTURER_CANDIDATES = ("Manufacturer", "Vendor", "@Manufacturer")
_SHORT_NAME_CANDIDATES = ("ShortName", "Abbreviation", "@ShortName")
_MODE_NAME_CANDIDATES = ("Mode/@Name", "Mode/Name", "ModeName", "@Mode")
_CHANNEL_CONTAINER_CANDIDATES = (
    ".//Channels/Channel",
    ".//DMXChannels/Channel",
    ".//Channel",
    ".//Parameter",
)


def _find_first_text(node: ET.Element, candidates: Iterable[str]) -> str | None:
    """First matching XPath candidate's text or attribute value, or None."""
    for path in candidates:
        # ElementTree's XPath does not support @-attributes, so peel them off.
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


def parse_onyx(xml_bytes: bytes) -> FixtureModel:
    """Turn AtlaBase CEF XML bytes into a :class:`FixtureModel`."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"ONYX XML is malformed: {exc}") from exc

    fixture_node: ET.Element | None = None
    for candidate in _FIXTURE_ROOT_CANDIDATES:
        fixture_node = root if candidate == "." else root.find(candidate)
        if fixture_node is not None:
            break
    if fixture_node is None:
        fixture_node = root

    fixture = FixtureModel(source_format="ONYX .Fixture")
    fixture.name = _find_first_text(fixture_node, _NAME_CANDIDATES) or fixture.name
    fixture.manufacturer = (
        _find_first_text(fixture_node, _MANUFACTURER_CANDIDATES) or fixture.manufacturer
    )
    fixture.short_name = (
        _find_first_text(fixture_node, _SHORT_NAME_CANDIDATES)
        or fixture.name[:8].upper().replace(" ", "")
        or fixture.short_name
    )
    fixture.mode_name = (
        _find_first_text(fixture_node, _MODE_NAME_CANDIDATES) or fixture.mode_name
    )

    channel_nodes: list[ET.Element] = []
    for path in _CHANNEL_CONTAINER_CANDIDATES:
        hits = fixture_node.findall(path)
        if hits:
            channel_nodes = hits
            break

    if not channel_nodes:
        raise ValueError(
            "No channel elements found in ONYX XML; the AtlaBase XPath "
            "likely needs updating for this fixture dialect."
        )

    for idx, ch in enumerate(channel_nodes, start=1):
        raw_name = (
            _find_first_text(ch, ("Name", "@Name", "Function", "Attribute"))
            or f"Channel{idx}"
        )
        classification = classify_attribute(raw_name)
        if classification is None:
            # Drop unclassified channels rather than emit opaque NoFeature
            # slots. Extend gdtf_writer.ATTRIBUTE_KEYWORDS to widen coverage.
            continue
        attribute, unit = classification

        # TODO(reverse-engineer): confirm offset attribute name. Public
        # samples have used "Offset", "DMX", "Address", "DMXOffset".
        offset = _parse_int(
            _find_first_text(ch, ("Offset", "@Offset", "DMX", "@DMX", "Address")),
            default=idx,
        )
        fine_offset_raw = _find_first_text(
            ch, ("FineOffset", "@FineOffset", "OffsetFine", "@OffsetFine")
        )
        fine_offset = _parse_int(fine_offset_raw, default=0) or None

        default_from, default_to, default_unit = DEFAULT_RANGES[attribute]
        physical_from = _parse_float(
            _find_first_text(ch, ("PhysicalFrom", "@PhysicalFrom", "MinPhysical")),
            default=default_from,
        )
        physical_to = _parse_float(
            _find_first_text(ch, ("PhysicalTo", "@PhysicalTo", "MaxPhysical")),
            default=default_to,
        )
        physical_unit = unit or default_unit
        default_dmx = _parse_int(
            _find_first_text(ch, ("Default", "@Default", "Home")),
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
            "ONYX file parsed but no supported channels remained after "
            "classification (Dimmer/Pan/Tilt/RGB/CMY)."
        )

    fixture.dmx_footprint = fixture.compute_footprint()
    return fixture


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert an Obsidian ONYX .Fixture personality to GDTF."
    )
    parser.add_argument("input", type=Path, help="Path to a .Fixture archive.")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="Destination .gdtf path (default: alongside input).")
    parser.add_argument("--inspect", action="store_true",
                        help="Parse and dump the mapped model; don't write GDTF.")
    args = parser.parse_args(argv)

    try:
        xml_bytes = read_onyx_xml(args.input)
        fixture = parse_onyx(xml_bytes)
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
