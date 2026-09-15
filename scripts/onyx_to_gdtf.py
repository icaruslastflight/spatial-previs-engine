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
(Base -> Yoke -> Head -> Beam) to be useful: the previz engine drives pan and
tilt by rotating those nodes about their local X axis (DIN SPEC 15800 section
6.4). See ``src/engine/GDTFParser.ts`` for the consumer side.

Scope of this MVP
-----------------
* Dimmer, Pan, Tilt, and either RGB (ColorAdd_R/G/B) or CMY (ColorSub_C/M/Y).
* One DMX mode, 8-bit channels only.
* Dummy Base/Yoke/Head/Beam geometry with plausible dimensions -- enough to let
  a previz tool build a moving-head chain that pans and tilts. Real photometry
  and per-fixture geometry stay a follow-up.

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
import io
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


# ---------------------------------------------------------------------------
# GDTF attribute vocabulary
# ---------------------------------------------------------------------------
# The subset of GDTF standard attributes this MVP emits. The engine's
# ACTIONABLE_ATTRIBUTES list in src/engine/GDTFParser.ts is the authoritative
# spelling -- keep the strings identical or the previz side will silently
# treat the channel as inert.
GDTF_ATTR_DIMMER = "Dimmer"
GDTF_ATTR_PAN = "Pan"
GDTF_ATTR_TILT = "Tilt"
GDTF_ATTR_RED = "ColorAdd_R"
GDTF_ATTR_GREEN = "ColorAdd_G"
GDTF_ATTR_BLUE = "ColorAdd_B"
GDTF_ATTR_CYAN = "ColorSub_C"
GDTF_ATTR_MAGENTA = "ColorSub_M"
GDTF_ATTR_YELLOW = "ColorSub_Y"

# Physical unit strings GDTF expects on <ChannelFunction PhysicalUnit="...">.
# "None" is the literal token used for dimensionless (0..1) parameters.
UNIT_NONE = "None"
UNIT_ANGLE = "Angle"
UNIT_LUMINOUS_INTENSITY = "LuminousIntensity"

# Feature grouping in GDTF -- the previz engine does not enforce it, but a
# console does. Keep it conservative and standard-conformant.
FEATURE_DIMMER = "Dimmer.Dimmer"
FEATURE_POSITION = "Position.PanTilt"
FEATURE_COLOR = "Color.ColorRGB"

# Defaults for the fabricated geometry. Nothing precise -- these are stand-in
# dimensions in metres that make a generic moving head. A downstream tool that
# needs true photometry should replace the geometry+beam block wholesale.
DUMMY_BASE_LENGTH_M = 0.32
DUMMY_BASE_WIDTH_M = 0.32
DUMMY_BASE_HEIGHT_M = 0.18
DUMMY_YOKE_LENGTH_M = 0.30
DUMMY_YOKE_WIDTH_M = 0.30
DUMMY_YOKE_HEIGHT_M = 0.28
DUMMY_HEAD_LENGTH_M = 0.24
DUMMY_HEAD_WIDTH_M = 0.24
DUMMY_HEAD_HEIGHT_M = 0.32
DUMMY_BEAM_RADIUS_M = 0.08
DUMMY_BEAM_LENGTH_M = 0.25
DUMMY_BEAM_ANGLE_DEG = 20.0
DUMMY_BEAM_LUMINOUS_FLUX_LM = 8000.0
DUMMY_BEAM_COLOR_TEMP_K = 6500.0


# ---------------------------------------------------------------------------
# Parsed ONYX model
# ---------------------------------------------------------------------------
@dataclass
class OnyxChannel:
    """One DMX channel extracted from the ONYX personality.

    ``offset`` is 1-based, matching how consoles patch. ``coarse_offset``
    equals ``offset``; ``fine_offset`` is populated only if the ONYX file
    declares a 16-bit pair (unused for the MVP but preserved for later).
    """

    name: str
    attribute: str            # a GDTF_ATTR_* string
    offset: int
    fine_offset: int | None = None
    physical_from: float = 0.0
    physical_to: float = 1.0
    physical_unit: str = UNIT_NONE
    default_dmx: int = 0


@dataclass
class OnyxFixture:
    name: str = "Unknown Fixture"
    short_name: str = "UNKFX"
    manufacturer: str = "Unknown"
    dmx_footprint: int = 0
    mode_name: str = "Default"
    channels: list[OnyxChannel] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Phase 1: extraction
# ---------------------------------------------------------------------------
def read_onyx_xml(fixture_path: Path) -> bytes:
    """Return the raw AtlaBase XML bytes from a ``.Fixture`` archive.

    ONYX ships one XML per archive but does not commit to a filename; picking
    "the first ``*.xml`` entry" is a pragmatic default that has held on every
    sample seen so far. If a real archive turns up with sidecar XMLs (e.g. a
    version manifest) tighten this to match on a known root element instead.
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
# sample before shipping. The parser reads several plausible tag spellings so
# small dialect drift does not blow the run up.

# Candidate paths for the top-level fixture element. ElementTree's find() will
# take the first match.
_FIXTURE_ROOT_CANDIDATES = (
    ".",                         # the root itself
    "./Fixture",
    "./FixtureDefinition",
    "./Personality",
)

_NAME_CANDIDATES = ("Name", "FixtureName", "Model", "@Name", "@name")
_MANUFACTURER_CANDIDATES = ("Manufacturer", "Vendor", "@Manufacturer")
_SHORT_NAME_CANDIDATES = ("ShortName", "Abbreviation", "@ShortName")
_MODE_NAME_CANDIDATES = ("Mode/@Name", "Mode/Name", "ModeName", "@Mode")

# ONYX groups per-channel data under a repeated element. The names below are
# the ones that show up in public sample dumps.
_CHANNEL_CONTAINER_CANDIDATES = (
    ".//Channels/Channel",
    ".//DMXChannels/Channel",
    ".//Channel",
    ".//Parameter",
)

# ONYX names its channels in dozens of ways ("Pan", "PAN", "Pan Coarse",
# "Pan16", "P"). Reduce to a canonical GDTF attribute via keyword matching --
# ordered longest-match-first so "ColorMixMagenta" wins over a bare "Magenta".
_ATTRIBUTE_KEYWORDS: tuple[tuple[str, str, str], ...] = (
    # (needle, gdtf attribute, physical unit)
    ("dimmer", GDTF_ATTR_DIMMER, UNIT_LUMINOUS_INTENSITY),
    ("intens", GDTF_ATTR_DIMMER, UNIT_LUMINOUS_INTENSITY),
    ("pan", GDTF_ATTR_PAN, UNIT_ANGLE),
    ("tilt", GDTF_ATTR_TILT, UNIT_ANGLE),
    ("red", GDTF_ATTR_RED, UNIT_NONE),
    ("green", GDTF_ATTR_GREEN, UNIT_NONE),
    ("blue", GDTF_ATTR_BLUE, UNIT_NONE),
    ("cyan", GDTF_ATTR_CYAN, UNIT_NONE),
    ("magenta", GDTF_ATTR_MAGENTA, UNIT_NONE),
    ("yellow", GDTF_ATTR_YELLOW, UNIT_NONE),
)

# Default physical ranges when the ONYX file doesn't publish one. Pan/tilt
# defaults follow the moving-head majority; a fixture with a wider throw will
# override these once the correct XPath is wired up.
_DEFAULT_RANGES: dict[str, tuple[float, float, str]] = {
    GDTF_ATTR_DIMMER: (0.0, 1.0, UNIT_NONE),
    GDTF_ATTR_PAN: (-270.0, 270.0, UNIT_ANGLE),
    GDTF_ATTR_TILT: (-135.0, 135.0, UNIT_ANGLE),
    GDTF_ATTR_RED: (0.0, 1.0, UNIT_NONE),
    GDTF_ATTR_GREEN: (0.0, 1.0, UNIT_NONE),
    GDTF_ATTR_BLUE: (0.0, 1.0, UNIT_NONE),
    GDTF_ATTR_CYAN: (0.0, 1.0, UNIT_NONE),
    GDTF_ATTR_MAGENTA: (0.0, 1.0, UNIT_NONE),
    GDTF_ATTR_YELLOW: (0.0, 1.0, UNIT_NONE),
}


def _find_first_text(node: ET.Element, candidates: Iterable[str]) -> str | None:
    """Return the text/attribute at the first matching candidate, or None."""
    for path in candidates:
        # A leading "@" (or embedded "/@") means "attribute". ElementTree's
        # XPath support does not cover attributes, so split them off by hand.
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


def _classify_attribute(name: str) -> tuple[str, str] | None:
    """Map a raw ONYX channel name to (GDTF attribute, physical unit)."""
    haystack = name.lower()
    for needle, attr, unit in _ATTRIBUTE_KEYWORDS:
        if needle in haystack:
            return attr, unit
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


def parse_onyx(xml_bytes: bytes) -> OnyxFixture:
    """Turn AtlaBase CEF XML bytes into an :class:`OnyxFixture`."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"ONYX XML is malformed: {exc}") from exc

    # Locate the fixture-level node. Fall back to the document root so a
    # flatter dialect still parses.
    # TODO(reverse-engineer): confirm the real root tag from a live sample.
    fixture_node: ET.Element | None = None
    for candidate in _FIXTURE_ROOT_CANDIDATES:
        if candidate == ".":
            fixture_node = root
        else:
            fixture_node = root.find(candidate)
        if fixture_node is not None:
            break
    if fixture_node is None:
        fixture_node = root

    fixture = OnyxFixture()
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

    # Channel extraction. Walk every candidate container and keep the first
    # one that returns a non-empty result -- ONYX personalities tend to use
    # exactly one shape per file.
    channel_nodes: list[ET.Element] = []
    for path in _CHANNEL_CONTAINER_CANDIDATES:
        hits = fixture_node.findall(path)
        if hits:
            channel_nodes = hits
            break

    if not channel_nodes:
        # A personality with zero recognizable channels is a hard failure --
        # the resulting GDTF would be an empty mode and immediately unusable.
        raise ValueError(
            "No channel elements found in ONYX XML; the AtlaBase XPath likely "
            "needs updating for this fixture dialect."
        )

    for idx, ch in enumerate(channel_nodes, start=1):
        raw_name = (
            _find_first_text(ch, ("Name", "@Name", "Function", "Attribute"))
            or f"Channel{idx}"
        )
        classification = _classify_attribute(raw_name)
        if classification is None:
            # Unknown channels are dropped rather than emitted as opaque
            # NoFeature slots -- keeps the MVP GDTF valid and small. Extend
            # ``_ATTRIBUTE_KEYWORDS`` and re-run to widen coverage.
            continue
        attribute, unit = classification

        # TODO(reverse-engineer): confirm the offset attribute name. Public
        # samples have used "Offset", "DMX", "Address", "DMXOffset". Coarse
        # only for now; a "FineOffset" sibling would enable 16-bit later.
        offset = _parse_int(
            _find_first_text(ch, ("Offset", "@Offset", "DMX", "@DMX", "Address")),
            default=idx,
        )
        fine_offset_raw = _find_first_text(
            ch, ("FineOffset", "@FineOffset", "OffsetFine", "@OffsetFine")
        )
        fine_offset = _parse_int(fine_offset_raw, default=0) or None

        default_from, default_to, default_unit = _DEFAULT_RANGES[attribute]
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

        fixture.channels.append(
            OnyxChannel(
                name=raw_name,
                attribute=attribute,
                offset=offset,
                fine_offset=fine_offset,
                physical_from=physical_from,
                physical_to=physical_to,
                physical_unit=physical_unit,
                default_dmx=default_dmx,
            )
        )

    if not fixture.channels:
        raise ValueError(
            "ONYX file parsed but no supported channels remained after "
            "classification (Dimmer/Pan/Tilt/RGB/CMY)."
        )

    # DMX footprint = highest occupied slot. This is how consoles count too.
    fixture.dmx_footprint = max(
        max(ch.offset, ch.fine_offset or 0) for ch in fixture.channels
    )
    return fixture


# ---------------------------------------------------------------------------
# Phase 3: GDTF description.xml generation
# ---------------------------------------------------------------------------
def _prettify(elem: ET.Element) -> bytes:
    """Serialize an ElementTree to indented UTF-8 XML bytes."""
    ET.indent(elem, space="  ")
    return ET.tostring(elem, encoding="utf-8", xml_declaration=True)


def _fixture_type_id(fixture: OnyxFixture) -> str:
    """Stable-ish GUID for the FixtureType attribute.

    GDTF expects a UUID string; deriving it from name+manufacturer means
    re-converting the same ONYX file twice yields the same FixtureTypeID,
    which keeps show files stable across regenerations.
    """
    seed = f"{fixture.manufacturer}|{fixture.name}|{fixture.mode_name}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"onyx-to-gdtf://{seed}"))


def _build_attribute_definitions(fixture: OnyxFixture) -> ET.Element:
    """Emit <AttributeDefinitions> for the attributes actually in use.

    GDTF requires every <ChannelFunction Attribute="..."> to resolve to an
    <Attribute> defined here, and each Attribute to belong to a <Feature>.
    """
    used = {ch.attribute for ch in fixture.channels}

    ad = ET.Element("AttributeDefinitions")

    # Activation groups: pan and tilt share one so the console treats them
    # as a coordinated position pair.
    groups = ET.SubElement(ad, "ActivationGroups")
    if GDTF_ATTR_PAN in used or GDTF_ATTR_TILT in used:
        ET.SubElement(groups, "ActivationGroup", {"Name": "PanTilt"})
    if used & {GDTF_ATTR_RED, GDTF_ATTR_GREEN, GDTF_ATTR_BLUE,
               GDTF_ATTR_CYAN, GDTF_ATTR_MAGENTA, GDTF_ATTR_YELLOW}:
        ET.SubElement(groups, "ActivationGroup", {"Name": "ColorRGB"})

    # Feature groups.
    fgs = ET.SubElement(ad, "FeatureGroups")
    if GDTF_ATTR_DIMMER in used:
        fg = ET.SubElement(fgs, "FeatureGroup",
                           {"Name": "Dimmer", "Pretty": "D"})
        ET.SubElement(fg, "Feature", {"Name": "Dimmer"})
    if GDTF_ATTR_PAN in used or GDTF_ATTR_TILT in used:
        fg = ET.SubElement(fgs, "FeatureGroup",
                           {"Name": "Position", "Pretty": "P"})
        ET.SubElement(fg, "Feature", {"Name": "PanTilt"})
    if used & {GDTF_ATTR_RED, GDTF_ATTR_GREEN, GDTF_ATTR_BLUE,
               GDTF_ATTR_CYAN, GDTF_ATTR_MAGENTA, GDTF_ATTR_YELLOW}:
        fg = ET.SubElement(fgs, "FeatureGroup",
                           {"Name": "Color", "Pretty": "C"})
        ET.SubElement(fg, "Feature", {"Name": "ColorRGB"})

    # Attribute -> Feature mapping. Keys mirror the previz engine's
    # ACTIONABLE_ATTRIBUTES list.
    attrs = ET.SubElement(ad, "Attributes")
    attr_specs: dict[str, tuple[str, str, str]] = {
        GDTF_ATTR_DIMMER:  ("Dim",     FEATURE_DIMMER,   ""),
        GDTF_ATTR_PAN:     ("P",       FEATURE_POSITION, "PanTilt"),
        GDTF_ATTR_TILT:    ("T",       FEATURE_POSITION, "PanTilt"),
        GDTF_ATTR_RED:     ("R",       FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_GREEN:   ("G",       FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_BLUE:    ("B",       FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_CYAN:    ("C",       FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_MAGENTA: ("M",       FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_YELLOW:  ("Y",       FEATURE_COLOR,    "ColorRGB"),
    }
    for attribute in sorted(used):
        pretty, feature, activation = attr_specs[attribute]
        attrib = {"Name": attribute, "Pretty": pretty, "Feature": feature}
        if activation:
            attrib["ActivationGroup"] = activation
        ET.SubElement(attrs, "Attribute", attrib)
    return ad


def _build_models() -> ET.Element:
    """Dummy geometry primitives: box for base/yoke/head, cone for beam.

    Length/Width/Height are metres per DIN SPEC 15800 section 6.1. These are
    generic moving-head-ish dimensions; a downstream tool that needs true
    photometry should replace this block wholesale.
    """
    models = ET.Element("Models")
    ET.SubElement(models, "Model", {
        "Name": "BaseModel", "Length": f"{DUMMY_BASE_LENGTH_M}",
        "Width": f"{DUMMY_BASE_WIDTH_M}", "Height": f"{DUMMY_BASE_HEIGHT_M}",
        "PrimitiveType": "Cube",
    })
    ET.SubElement(models, "Model", {
        "Name": "YokeModel", "Length": f"{DUMMY_YOKE_LENGTH_M}",
        "Width": f"{DUMMY_YOKE_WIDTH_M}", "Height": f"{DUMMY_YOKE_HEIGHT_M}",
        "PrimitiveType": "Yoke",
    })
    ET.SubElement(models, "Model", {
        "Name": "HeadModel", "Length": f"{DUMMY_HEAD_LENGTH_M}",
        "Width": f"{DUMMY_HEAD_WIDTH_M}", "Height": f"{DUMMY_HEAD_HEIGHT_M}",
        "PrimitiveType": "Head",
    })
    ET.SubElement(models, "Model", {
        "Name": "BeamModel", "Length": f"{DUMMY_BEAM_LENGTH_M}",
        "Width": f"{DUMMY_BEAM_RADIUS_M * 2}",
        "Height": f"{DUMMY_BEAM_RADIUS_M * 2}",
        "PrimitiveType": "Cone",
    })
    return models


def _identity_matrix() -> str:
    """4x4 identity in GDTF's row-major, brace-delimited textual form."""
    return "{1.000000,0.000000,0.000000,0.000000}" \
           "{0.000000,1.000000,0.000000,0.000000}" \
           "{0.000000,0.000000,1.000000,0.000000}" \
           "{0.000000,0.000000,0.000000,1.000000}"


def _translation_matrix(x: float, y: float, z: float) -> str:
    """Row-major 4x4 with a pure translation in metres."""
    return (
        f"{{1.000000,0.000000,0.000000,{x:.6f}}}"
        f"{{0.000000,1.000000,0.000000,{y:.6f}}}"
        f"{{0.000000,0.000000,1.000000,{z:.6f}}}"
        f"{{0.000000,0.000000,0.000000,1.000000}}"
    )


def _build_geometries(fixture: OnyxFixture) -> ET.Element:
    """
    Fabricate the Base -> Yoke -> Head -> Beam chain the previz engine expects.

    GDTF <Axis> nodes rotate about their own local X (DIN SPEC 15800 section
    6.4); the axis's *own* Position matrix is what orients that rotation in
    parent space. So the yoke rotates around vertical (mounting) and the head
    rotates around a lateral axis -- we place each accordingly.
    """
    used = {ch.attribute for ch in fixture.channels}

    geometries = ET.Element("Geometries")
    base = ET.SubElement(geometries, "Geometry", {
        "Name": "Base", "Model": "BaseModel", "Matrix": _identity_matrix(),
    })

    # Yoke sits on top of the base, rotating about the world Z axis. Local X
    # of the yoke has to point up -- so we translate up and reorient. This
    # matrix rotates local X -> world +Z, keeping the yoke's local X vertical.
    yoke_matrix = (
        "{0.000000,0.000000,1.000000,0.000000}"
        "{1.000000,0.000000,0.000000,0.000000}"
        "{0.000000,1.000000,0.000000," f"{DUMMY_BASE_HEIGHT_M:.6f}" "}"
        "{0.000000,0.000000,0.000000,1.000000}"
    )
    yoke_attrs = {"Name": "Yoke", "Model": "YokeModel", "Matrix": yoke_matrix}
    yoke = ET.SubElement(base, "Axis" if GDTF_ATTR_PAN in used else "Geometry",
                         yoke_attrs)

    # Head hangs off the yoke. Its local X points along the tilt axis
    # (horizontal, perpendicular to pan) -- identity matrix + a Y translation
    # is close enough for a stand-in.
    head_matrix = _translation_matrix(0.0, DUMMY_YOKE_HEIGHT_M, 0.0)
    head_attrs = {"Name": "Head", "Model": "HeadModel", "Matrix": head_matrix}
    head = ET.SubElement(yoke, "Axis" if GDTF_ATTR_TILT in used else "Geometry",
                         head_attrs)

    # Beam. GDTF <Beam> carries the photometry the previz engine reads to
    # size its SpotLight. Flux is the total lumens; the resolver converts to
    # candela via the field angle (GDTFAssetResolver.fluxToCandela).
    ET.SubElement(head, "Beam", {
        "Name": "Beam",
        "Model": "BeamModel",
        "Matrix": _translation_matrix(0.0, 0.0, DUMMY_HEAD_HEIGHT_M / 2.0),
        "LampType": "LED",
        "PowerConsumption": "300",
        "LuminousFlux": f"{DUMMY_BEAM_LUMINOUS_FLUX_LM}",
        "ColorTemperature": f"{DUMMY_BEAM_COLOR_TEMP_K}",
        "BeamAngle": f"{DUMMY_BEAM_ANGLE_DEG}",
        "FieldAngle": f"{DUMMY_BEAM_ANGLE_DEG}",
        "BeamRadius": f"{DUMMY_BEAM_RADIUS_M}",
        "BeamType": "Wash",
        "ColorRenderingIndex": "80",
    })
    return geometries


def _geometry_target(attribute: str) -> str:
    """Which <Geometry> node in the chain each attribute drives."""
    if attribute == GDTF_ATTR_PAN:
        return "Yoke"
    if attribute == GDTF_ATTR_TILT:
        return "Head"
    # Dimmer and colour all live on the beam.
    return "Beam"


def _build_dmx_modes(fixture: OnyxFixture) -> ET.Element:
    """Emit <DMXModes> with a single <DMXMode> holding one channel per attr."""
    modes = ET.Element("DMXModes")
    mode = ET.SubElement(modes, "DMXMode",
                         {"Name": fixture.mode_name, "Geometry": "Base"})
    dmx_channels = ET.SubElement(mode, "DMXChannels")

    for ch in sorted(fixture.channels, key=lambda c: c.offset):
        # GDTF encodes the offset list as a comma-joined string; the fine
        # byte, if present, comes second.
        offsets = f"{ch.offset}"
        if ch.fine_offset:
            offsets = f"{ch.offset},{ch.fine_offset}"

        channel_el = ET.SubElement(dmx_channels, "DMXChannel", {
            "DMXBreak": "1",
            "Offset": offsets,
            "Default": f"{ch.default_dmx}/1",
            "Highlight": "None",
            "Geometry": _geometry_target(ch.attribute),
        })
        logical = ET.SubElement(channel_el, "LogicalChannel", {
            "Attribute": ch.attribute,
            "Snap": "No",
            "Master": "None",
            "MibFade": "0",
            "DMXChangeTimeLimit": "0",
        })
        ET.SubElement(logical, "ChannelFunction", {
            "Name": ch.attribute,
            "Attribute": ch.attribute,
            "OriginalAttribute": ch.name,
            "DMXFrom": "0/1",
            "Default": f"{ch.default_dmx}/1",
            "PhysicalFrom": f"{ch.physical_from}",
            "PhysicalTo": f"{ch.physical_to}",
            "RealFade": "0",
            "PhysicalUnit": ch.physical_unit,
        })
    return modes


def build_description_xml(fixture: OnyxFixture) -> bytes:
    """Assemble the full GDTF ``description.xml`` document."""
    gdtf = ET.Element("GDTF", {"DataVersion": "1.2"})
    fixture_type = ET.SubElement(gdtf, "FixtureType", {
        "Name": fixture.name,
        "ShortName": fixture.short_name,
        "LongName": fixture.name,
        "Manufacturer": fixture.manufacturer,
        "Description": (
            f"Converted from ONYX .Fixture by onyx_to_gdtf.py on "
            f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}"
        ),
        "FixtureTypeID": _fixture_type_id(fixture),
        "RefFT": "",
    })
    fixture_type.append(_build_attribute_definitions(fixture))
    # Wheels and PhysicalDescriptions are required by the schema even when
    # empty -- omit and strict validators reject the file.
    ET.SubElement(fixture_type, "Wheels")
    ET.SubElement(fixture_type, "PhysicalDescriptions")
    fixture_type.append(_build_models())
    fixture_type.append(_build_geometries(fixture))
    fixture_type.append(_build_dmx_modes(fixture))
    # Protocols/Revisions round out the required-but-often-empty tail.
    ET.SubElement(fixture_type, "Protocols")
    revisions = ET.SubElement(fixture_type, "Revisions")
    ET.SubElement(revisions, "Revision", {
        "Text": "Generated from ONYX .Fixture by onyx_to_gdtf.py",
        "Date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "UserID": "0",
    })
    return _prettify(gdtf)


# ---------------------------------------------------------------------------
# Phase 4: packaging
# ---------------------------------------------------------------------------
def write_gdtf(fixture: OnyxFixture, description_xml: bytes,
               output_path: Path) -> None:
    """Zip a GDTF archive with ``description.xml`` at the root."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Use an in-memory buffer first so a mid-write failure never leaves a
    # half-written .gdtf behind for a downstream tool to trip over.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("description.xml", description_xml)
        # GDTF wants these two folders even when empty. `zipfile` needs the
        # trailing slash to record them as directories.
        zf.writestr("models/", b"")
        zf.writestr("wheels/", b"")
    output_path.write_bytes(buffer.getvalue())


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print_inspection(fixture: OnyxFixture) -> None:
    print(f"Fixture:      {fixture.name}")
    print(f"Manufacturer: {fixture.manufacturer}")
    print(f"Short name:   {fixture.short_name}")
    print(f"Mode:         {fixture.mode_name}")
    print(f"DMX footprint: {fixture.dmx_footprint}")
    print("Channels:")
    for ch in sorted(fixture.channels, key=lambda c: c.offset):
        fine = f" (fine +{ch.fine_offset})" if ch.fine_offset else ""
        print(
            f"  [{ch.offset:>3}]{fine} {ch.attribute:<14} "
            f"'{ch.name}' {ch.physical_from}..{ch.physical_to} "
            f"{ch.physical_unit}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("input", type=Path,
                        help="Path to an ONYX .Fixture archive.")
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
        _print_inspection(fixture)
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
