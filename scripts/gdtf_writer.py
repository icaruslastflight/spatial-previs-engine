"""
Shared GDTF ``description.xml`` builder + archive packager.

Format-specific parsers (``onyx_to_gdtf.py``, ``capture_to_gdtf.py``) build a
``FixtureModel`` from their vendor XML and hand it here. The heavy lifting --
attribute definitions, dummy geometry, DMX mode, packaging -- is identical
across parsers and lives in exactly one place.

Everything here mirrors DIN SPEC 15800:2022-02 conventions and stays in step
with ``src/engine/GDTFParser.ts`` on the consumer side. The engine's
``ACTIONABLE_ATTRIBUTES`` list is the authoritative spelling for attribute
names; the constants below repeat those spellings so a typo shows up here,
not silently in the previz.
"""

from __future__ import annotations

import io
import uuid
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Attribute vocabulary
# ---------------------------------------------------------------------------
GDTF_ATTR_DIMMER = "Dimmer"
GDTF_ATTR_PAN = "Pan"
GDTF_ATTR_TILT = "Tilt"
GDTF_ATTR_RED = "ColorAdd_R"
GDTF_ATTR_GREEN = "ColorAdd_G"
GDTF_ATTR_BLUE = "ColorAdd_B"
GDTF_ATTR_CYAN = "ColorSub_C"
GDTF_ATTR_MAGENTA = "ColorSub_M"
GDTF_ATTR_YELLOW = "ColorSub_Y"

UNIT_NONE = "None"
UNIT_ANGLE = "Angle"
UNIT_LUMINOUS_INTENSITY = "LuminousIntensity"

FEATURE_DIMMER = "Dimmer.Dimmer"
FEATURE_POSITION = "Position.PanTilt"
FEATURE_COLOR = "Color.ColorRGB"

# Longest-match-first keyword table for classifying a raw vendor channel name
# ("Pan Coarse", "PAN", "P", "ColorMixMagenta", ...) into a GDTF attribute.
# Ordered longest-first so "ColorMixMagenta" wins over a bare "Magenta".
ATTRIBUTE_KEYWORDS: tuple[tuple[str, str, str], ...] = (
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

# Default physical ranges when the source file doesn't publish one. Pan/tilt
# defaults follow the moving-head majority.
DEFAULT_RANGES: dict[str, tuple[float, float, str]] = {
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


def classify_attribute(name: str) -> tuple[str, str] | None:
    """Map a raw vendor channel name to (GDTF attribute, physical unit)."""
    haystack = name.lower()
    for needle, attr, unit in ATTRIBUTE_KEYWORDS:
        if needle in haystack:
            return attr, unit
    return None


# ---------------------------------------------------------------------------
# Dummy geometry dimensions (metres). Real photometry replaces these later.
# ---------------------------------------------------------------------------
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
# The vendor-agnostic parsed model
# ---------------------------------------------------------------------------
@dataclass
class ChannelModel:
    """One DMX channel extracted from a vendor personality.

    ``offset`` is 1-based, matching how consoles patch. ``fine_offset`` is
    populated only when the source declares a 16-bit pair; the MVP writer
    still emits it if present so a downstream tool sees the full precision.
    """
    name: str
    attribute: str
    offset: int
    fine_offset: int | None = None
    physical_from: float = 0.0
    physical_to: float = 1.0
    physical_unit: str = UNIT_NONE
    default_dmx: int = 0


@dataclass
class FixtureModel:
    """Vendor-agnostic fixture personality; parsers produce these."""
    name: str = "Unknown Fixture"
    short_name: str = "UNKFX"
    manufacturer: str = "Unknown"
    dmx_footprint: int = 0
    mode_name: str = "Default"
    source_format: str = "unknown"
    channels: list[ChannelModel] = field(default_factory=list)

    def compute_footprint(self) -> int:
        """Highest occupied DMX slot -- how a console counts."""
        if not self.channels:
            return 0
        return max(
            max(ch.offset, ch.fine_offset or 0) for ch in self.channels
        )


# ---------------------------------------------------------------------------
# description.xml assembly
# ---------------------------------------------------------------------------
def _fixture_type_id(fixture: FixtureModel) -> str:
    """Stable UUIDv5 for FixtureTypeID.

    GDTF wants a UUID string; deriving it from name+manufacturer+mode means
    re-converting the same source file twice yields the same FixtureTypeID,
    which keeps show files stable across regenerations.
    """
    seed = f"{fixture.manufacturer}|{fixture.name}|{fixture.mode_name}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"fixture-to-gdtf://{seed}"))


def _build_attribute_definitions(fixture: FixtureModel) -> ET.Element:
    """Emit <AttributeDefinitions> covering only the attributes in use."""
    used = {ch.attribute for ch in fixture.channels}

    ad = ET.Element("AttributeDefinitions")
    groups = ET.SubElement(ad, "ActivationGroups")
    if GDTF_ATTR_PAN in used or GDTF_ATTR_TILT in used:
        ET.SubElement(groups, "ActivationGroup", {"Name": "PanTilt"})
    if used & {GDTF_ATTR_RED, GDTF_ATTR_GREEN, GDTF_ATTR_BLUE,
               GDTF_ATTR_CYAN, GDTF_ATTR_MAGENTA, GDTF_ATTR_YELLOW}:
        ET.SubElement(groups, "ActivationGroup", {"Name": "ColorRGB"})

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

    attrs = ET.SubElement(ad, "Attributes")
    attr_specs: dict[str, tuple[str, str, str]] = {
        GDTF_ATTR_DIMMER:  ("Dim", FEATURE_DIMMER,   ""),
        GDTF_ATTR_PAN:     ("P",   FEATURE_POSITION, "PanTilt"),
        GDTF_ATTR_TILT:    ("T",   FEATURE_POSITION, "PanTilt"),
        GDTF_ATTR_RED:     ("R",   FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_GREEN:   ("G",   FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_BLUE:    ("B",   FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_CYAN:    ("C",   FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_MAGENTA: ("M",   FEATURE_COLOR,    "ColorRGB"),
        GDTF_ATTR_YELLOW:  ("Y",   FEATURE_COLOR,    "ColorRGB"),
    }
    for attribute in sorted(used):
        pretty, feature, activation = attr_specs[attribute]
        attrib = {"Name": attribute, "Pretty": pretty, "Feature": feature}
        if activation:
            attrib["ActivationGroup"] = activation
        ET.SubElement(attrs, "Attribute", attrib)
    return ad


def _identity_matrix() -> str:
    return ("{1.000000,0.000000,0.000000,0.000000}"
            "{0.000000,1.000000,0.000000,0.000000}"
            "{0.000000,0.000000,1.000000,0.000000}"
            "{0.000000,0.000000,0.000000,1.000000}")


def _translation_matrix(x: float, y: float, z: float) -> str:
    return (
        f"{{1.000000,0.000000,0.000000,{x:.6f}}}"
        f"{{0.000000,1.000000,0.000000,{y:.6f}}}"
        f"{{0.000000,0.000000,1.000000,{z:.6f}}}"
        f"{{0.000000,0.000000,0.000000,1.000000}}"
    )


def _build_models() -> ET.Element:
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


def _build_geometries(fixture: FixtureModel) -> ET.Element:
    """
    Base -> Yoke -> Head -> Beam chain. GDTF <Axis> nodes rotate about their
    own local X (DIN SPEC 15800 §6.4); each axis's Position matrix is what
    orients that rotation in parent space -- so the yoke reads as vertical
    and the head reads as horizontal.
    """
    used = {ch.attribute for ch in fixture.channels}
    geometries = ET.Element("Geometries")
    base = ET.SubElement(geometries, "Geometry", {
        "Name": "Base", "Model": "BaseModel", "Matrix": _identity_matrix(),
    })

    # Yoke: rotate local X onto world +Z so pan spins about vertical.
    yoke_matrix = (
        "{0.000000,0.000000,1.000000,0.000000}"
        "{1.000000,0.000000,0.000000,0.000000}"
        "{0.000000,1.000000,0.000000," f"{DUMMY_BASE_HEIGHT_M:.6f}" "}"
        "{0.000000,0.000000,0.000000,1.000000}"
    )
    yoke_attrs = {"Name": "Yoke", "Model": "YokeModel", "Matrix": yoke_matrix}
    yoke = ET.SubElement(base, "Axis" if GDTF_ATTR_PAN in used else "Geometry",
                         yoke_attrs)

    # Head: tilt axis lies along local X; identity + Y translation is close
    # enough for a stand-in.
    head_matrix = _translation_matrix(0.0, DUMMY_YOKE_HEIGHT_M, 0.0)
    head_attrs = {"Name": "Head", "Model": "HeadModel", "Matrix": head_matrix}
    head = ET.SubElement(yoke, "Axis" if GDTF_ATTR_TILT in used else "Geometry",
                         head_attrs)

    # Beam carries the photometry the previz engine reads to size its
    # SpotLight (GDTFAssetResolver.fluxToCandela).
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
    if attribute == GDTF_ATTR_PAN:
        return "Yoke"
    if attribute == GDTF_ATTR_TILT:
        return "Head"
    return "Beam"


def _build_dmx_modes(fixture: FixtureModel) -> ET.Element:
    modes = ET.Element("DMXModes")
    mode = ET.SubElement(modes, "DMXMode",
                         {"Name": fixture.mode_name, "Geometry": "Base"})
    dmx_channels = ET.SubElement(mode, "DMXChannels")

    for ch in sorted(fixture.channels, key=lambda c: c.offset):
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


def build_description_xml(fixture: FixtureModel) -> bytes:
    """Assemble the full GDTF ``description.xml`` document."""
    gdtf = ET.Element("GDTF", {"DataVersion": "1.2"})
    fixture_type = ET.SubElement(gdtf, "FixtureType", {
        "Name": fixture.name,
        "ShortName": fixture.short_name,
        "LongName": fixture.name,
        "Manufacturer": fixture.manufacturer,
        "Description": (
            f"Converted from {fixture.source_format} by fixture-to-gdtf on "
            f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}"
        ),
        "FixtureTypeID": _fixture_type_id(fixture),
        "RefFT": "",
    })
    fixture_type.append(_build_attribute_definitions(fixture))
    # Wheels / PhysicalDescriptions are schema-required even when empty --
    # strict validators reject the file otherwise.
    ET.SubElement(fixture_type, "Wheels")
    ET.SubElement(fixture_type, "PhysicalDescriptions")
    fixture_type.append(_build_models())
    fixture_type.append(_build_geometries(fixture))
    fixture_type.append(_build_dmx_modes(fixture))
    ET.SubElement(fixture_type, "Protocols")
    revisions = ET.SubElement(fixture_type, "Revisions")
    ET.SubElement(revisions, "Revision", {
        "Text": f"Generated from {fixture.source_format} by fixture-to-gdtf",
        "Date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "UserID": "0",
    })
    ET.indent(gdtf, space="  ")
    return ET.tostring(gdtf, encoding="utf-8", xml_declaration=True)


def write_gdtf(fixture: FixtureModel, description_xml: bytes,
               output_path: Path) -> None:
    """Zip a GDTF archive with ``description.xml`` at the root.

    Buffered so a mid-write failure never leaves a half-written .gdtf behind
    for a downstream tool to trip over.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("description.xml", description_xml)
        # Empty models/ and wheels/ directories still required by the spec.
        zf.writestr("models/", b"")
        zf.writestr("wheels/", b"")
    output_path.write_bytes(buffer.getvalue())


# ---------------------------------------------------------------------------
# CLI helpers reused by both format-specific converters
# ---------------------------------------------------------------------------
def print_inspection(fixture: FixtureModel) -> None:
    print(f"Fixture:       {fixture.name}")
    print(f"Manufacturer:  {fixture.manufacturer}")
    print(f"Short name:    {fixture.short_name}")
    print(f"Mode:          {fixture.mode_name}")
    print(f"Source format: {fixture.source_format}")
    print(f"DMX footprint: {fixture.dmx_footprint}")
    print("Channels:")
    for ch in sorted(fixture.channels, key=lambda c: c.offset):
        fine = f" (fine +{ch.fine_offset})" if ch.fine_offset else ""
        print(
            f"  [{ch.offset:>3}]{fine} {ch.attribute:<14} "
            f"'{ch.name}' {ch.physical_from}..{ch.physical_to} "
            f"{ch.physical_unit}"
        )
