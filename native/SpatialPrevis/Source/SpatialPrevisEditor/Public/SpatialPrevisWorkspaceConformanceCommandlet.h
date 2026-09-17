#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "SpatialPrevisWorkspaceConformanceCommandlet.generated.h"

/** Executes the shared TypeScript-authored workspace corpus using real native APIs. */
UCLASS()
class USpatialPrevisWorkspaceConformanceCommandlet : public UCommandlet
{
    GENERATED_BODY()
public:
    USpatialPrevisWorkspaceConformanceCommandlet();
    virtual int32 Main(const FString& Params) override;
};
