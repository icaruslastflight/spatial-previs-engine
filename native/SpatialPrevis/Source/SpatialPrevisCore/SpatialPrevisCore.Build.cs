using UnrealBuildTool;

public class SpatialPrevisCore : ModuleRules
{
    public SpatialPrevisCore(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        // Keep private codec/store helpers isolated in their translation units.
        bUseUnity = false;
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "Json" });
    }
}
