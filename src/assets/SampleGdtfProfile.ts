/**
 * A synthetic GDTF profile standing in for real GDTF Share catalogue data.
 *
 * Real manufacturer fixtures (Robe MegaPointe, Martin MAC Aura, Claypaky
 * Sharpy, GLP JDC1) need a fetched-and-cached `.gdtf` archive, which needs a
 * free GDTF Share account -- see `scripts/fetch_gdtf_library.js` and
 * CLAUDE.md §11. Until one is cached, this hand-authored profile exercises
 * the REAL parsing path end to end (it is XML, run through
 * `parseDescriptionXml()`, exactly like a fetched archive's
 * `description.xml` would be) rather than a shortcut that bypasses the
 * parser -- the same "synthetic stand-in exercises the real pipeline"
 * contract `cleanup_splat.py --synthesize` and the procedural modular assets
 * (§9) already use for their own missing-real-asset gap.
 *
 * A generic 300 W LED wash: a two-axis Yoke -> Head chain (typical moving-
 * head topology) with one Beam node.
 */
export const SAMPLE_GDTF_DESCRIPTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="Generic Wash 300 LED" ShortName="GW300" Manufacturer="Festival Visualizer (synthetic)"
      Description="Placeholder moving-head wash, standing in for a real GDTF Share fixture until one is fetched."
      FixtureTypeID="7c9f6e2a-6b3d-4a1e-9c8f-3d5a7e1b2c4d">
    <Models>
      <Model Name="base_model" Length="0.42" Width="0.34" Height="0.38" PrimitiveType="Base" File="base_model"/>
      <Model Name="head_model" Length="0.26" Width="0.24" Height="0.30" PrimitiveType="Head" File="head_model"/>
    </Models>
    <Geometries>
      <Axis Name="Yoke" Model="base_model" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0.34}{0,0,0,1}">
        <Axis Name="Head" Model="head_model" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0.17}{0,0,0,1}">
          <Beam Name="Beam" Model="head_model" LampType="LED" PowerConsumption="300" LuminousFlux="8000"
              ColorTemperature="6500" BeamAngle="22" FieldAngle="26" BeamType="Wash"/>
        </Axis>
      </Axis>
    </Geometries>
    <DMXModes>
      <DMXMode Name="Standard 5ch" Geometry="Yoke">
        <DMXChannels>
          <DMXChannel Geometry="Yoke" Offset="1,2" Default="32768/2" DMXBreak="1">
            <LogicalChannel Attribute="Pan">
              <ChannelFunction Name="Pan" PhysicalFrom="-270" PhysicalTo="270" Default="32768/2"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel Geometry="Head" Offset="3,4" Default="32768/2" DMXBreak="1">
            <LogicalChannel Attribute="Tilt">
              <ChannelFunction Name="Tilt" PhysicalFrom="-135" PhysicalTo="135" Default="32768/2"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel Geometry="Beam" Offset="5" Default="0" DMXBreak="1">
            <LogicalChannel Attribute="Dimmer">
              <ChannelFunction Name="Dimmer" PhysicalFrom="0" PhysicalTo="1" Default="0"/>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>`;
