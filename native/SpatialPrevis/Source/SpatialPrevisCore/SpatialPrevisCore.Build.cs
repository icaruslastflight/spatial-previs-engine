using UnrealBuildTool;

public class SpatialPrevisCore : ModuleRules
{
    public SpatialPrevisCore(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "Json" });
    }
}
