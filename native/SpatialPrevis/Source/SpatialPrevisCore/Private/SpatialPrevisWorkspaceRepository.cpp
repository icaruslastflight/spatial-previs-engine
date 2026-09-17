#include "SpatialPrevisWorkspaceRepository.h"

#include "SpatialPrevisWorkspaceCodec.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include <cmath>

#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#endif

namespace
{
using FObject = TSharedPtr<FJsonObject>;
using FValue = TSharedPtr<FJsonValue>;
constexpr int64 MaximumGeneration = 9007199254740991LL;
constexpr int32 MaximumProjects = 1024;
constexpr int32 MaximumManifestBytes = 256 * 1024 * 1024;

bool Same(const FString& A, const FString& B)
{
	return A.Len() == B.Len() && (A.IsEmpty() ||
		FMemory::Memcmp(*A, *B, A.Len() * sizeof(TCHAR)) == 0);
}

FValue Field(const FObject& Object, const TCHAR* Name)
{
	if (!Object.IsValid()) return nullptr;
	const FString Expected(Name);
	for (const auto& Entry : Object->Values)
		if (Same(FString(Entry.Key.Len(), *Entry.Key), Expected)) return Entry.Value;
	return nullptr;
}

bool Type(const FValue& Value, EJson Expected)
{
	return Value.IsValid() && Value->Type == Expected;
}

FString String(const FObject& Object, const TCHAR* Name)
{
	return Field(Object, Name)->AsString();
}

bool Fail(FString& Error, const FString& Message)
{
	Error = TEXT("Workspace storage: ") + Message;
	return false;
}

struct FStoredWorkspace
{
	FString ProjectId;
	int64 Generation = 0;
	FString Json;
};

struct FManifest
{
	FString ActiveProjectId;
	TArray<FStoredWorkspace> Workspaces;

	int32 Find(const FString& ProjectId) const
	{
		for (int32 I = 0; I < Workspaces.Num(); ++I)
			if (Same(Workspaces[I].ProjectId, ProjectId)) return I;
		return INDEX_NONE;
	}
};

// The private on-disk format is deterministic ASCII JSON. Escaping code units
// preserves embedded NULs and unpaired UTF-16 surrogates in workspace strings.
// Project IDs are data, never path segments or case-insensitive filesystem keys.
FString Quote(const FString& Value)
{
	FString Result(TEXT("\""));
	for (int32 I = 0; I < Value.Len(); ++I)
	{
		const uint32 C = static_cast<uint32>(Value[I]);
		if (C == '"') Result += TEXT("\\\"");
		else if (C == '\\') Result += TEXT("\\\\");
		else if (C >= 0x20 && C <= 0x7e) Result.AppendChar(Value[I]);
		else if (C <= 0xffff) Result += FString::Printf(TEXT("\\u%04x"), C);
		else
		{
			const uint32 Scalar = C - 0x10000;
			Result += FString::Printf(TEXT("\\u%04x\\u%04x"),
				0xd800 + (Scalar >> 10), 0xdc00 + (Scalar & 0x3ff));
		}
	}
	Result.AppendChar('"');
	return Result;
}

FString ManifestJson(const FManifest& Manifest)
{
	FString Result = TEXT("{\"format\":\"spatial-previs-native-store\",\"version\":1,\"activeProjectId\":");
	Result += Manifest.ActiveProjectId.IsEmpty() ? TEXT("null") : Quote(Manifest.ActiveProjectId);
	Result += TEXT(",\"workspaces\":[");
	for (int32 I = 0; I < Manifest.Workspaces.Num(); ++I)
	{
		const FStoredWorkspace& Entry = Manifest.Workspaces[I];
		if (I != 0) Result.AppendChar(',');
		Result += TEXT("{\"projectId\":") + Quote(Entry.ProjectId) +
			FString::Printf(TEXT(",\"generation\":%lld,\"json\":"), static_cast<long long>(Entry.Generation)) +
			Quote(Entry.Json) + TEXT("}");
	}
	Result += TEXT("]}");
	return Result;
}

bool ParseManifest(const FString& Json, FManifest& Out, FString& Error)
{
	FObject Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid() || Root->Values.Num() != 4 ||
		!Type(Field(Root, TEXT("format")), EJson::String) ||
		!Same(String(Root, TEXT("format")), TEXT("spatial-previs-native-store")) ||
		!Type(Field(Root, TEXT("version")), EJson::Number) || Field(Root, TEXT("version"))->AsNumber() != 1.0 ||
		!Type(Field(Root, TEXT("workspaces")), EJson::Array) ||
		(!Type(Field(Root, TEXT("activeProjectId")), EJson::String) && !Type(Field(Root, TEXT("activeProjectId")), EJson::Null)))
		return Fail(Error, TEXT("invalid or unsupported manifest; existing storage was not overwritten"));
	FManifest Parsed;
	if (Type(Field(Root, TEXT("activeProjectId")), EJson::String))
	{
		Parsed.ActiveProjectId = String(Root, TEXT("activeProjectId"));
		if (Parsed.ActiveProjectId.IsEmpty()) return Fail(Error, TEXT("invalid active project ID"));
	}
	const TArray<FValue>& Entries = Field(Root, TEXT("workspaces"))->AsArray();
	if (Entries.Num() > MaximumProjects) return Fail(Error, TEXT("manifest exceeds the R0 project limit"));
	for (const FValue& Value : Entries)
	{
		if (!Type(Value, EJson::Object)) return Fail(Error, TEXT("invalid stored workspace entry"));
		const FObject& Object = Value->AsObject();
		if (Object->Values.Num() != 3 || !Type(Field(Object, TEXT("projectId")), EJson::String) ||
			!Type(Field(Object, TEXT("generation")), EJson::Number) || !Type(Field(Object, TEXT("json")), EJson::String))
			return Fail(Error, TEXT("invalid stored workspace fields"));
		const double Generation = Field(Object, TEXT("generation"))->AsNumber();
		if (!std::isfinite(Generation) || Generation < 1 || Generation > static_cast<double>(MaximumGeneration) ||
			std::floor(Generation) != Generation)
			return Fail(Error, TEXT("invalid saved generation"));
		FStoredWorkspace Entry;
		Entry.ProjectId = String(Object, TEXT("projectId"));
		Entry.Generation = static_cast<int64>(Generation);
		Entry.Json = String(Object, TEXT("json"));
		if (Entry.ProjectId.IsEmpty() || Parsed.Find(Entry.ProjectId) != INDEX_NONE)
			return Fail(Error, TEXT("empty or duplicate stored project ID"));
		FObject Workspace;
		if (!FSpatialPrevisWorkspaceCodec::Parse(Entry.Json, Workspace, Error)) return false;
		if (!Same(String(Field(Workspace, TEXT("project"))->AsObject(), TEXT("projectId")), Entry.ProjectId))
			return Fail(Error, TEXT("stored project identity mismatch"));
		Parsed.Workspaces.Add(MoveTemp(Entry));
	}
	if ((Parsed.Workspaces.IsEmpty() && !Parsed.ActiveProjectId.IsEmpty()) ||
		(!Parsed.Workspaces.IsEmpty() && Parsed.Find(Parsed.ActiveProjectId) == INDEX_NONE))
		return Fail(Error, TEXT("active project does not refer to a saved workspace"));
	// Only this writer creates manifests. Exact private-format reconstruction also
	// rejects duplicate JSON fields, trailing tokens, unknown fields and ambiguous
	// number/string spellings which a permissive JSON reader might otherwise accept.
	if (!Same(ManifestJson(Parsed), Json))
		return Fail(Error, TEXT("noncanonical or damaged manifest; existing storage was not overwritten"));
	Out = MoveTemp(Parsed);
	return true;
}

#if PLATFORM_WINDOWS
bool WinError(FString& Error, const TCHAR* Operation, DWORD Code = ::GetLastError())
{
	return Fail(Error, FString::Printf(TEXT("%s failed (Windows error %lu); keep or export unsaved changes"), Operation,
		static_cast<unsigned long>(Code)));
}

class FRepositoryLock
{
public:
	~FRepositoryLock()
	{
		if (Handle != INVALID_HANDLE_VALUE)
		{
			if (Locked) ::UnlockFileEx(Handle, 0, 1, 0, &Overlap);
			::CloseHandle(Handle);
		}
	}
	bool Acquire(const FString& Directory, FString& Error)
	{
		if (Directory.IsEmpty()) return Fail(Error, TEXT("a storage directory is required"));
		for (int32 I = 0; I < Directory.Len(); ++I)
			if (Directory[I] == 0) return Fail(Error, TEXT("storage path contains a NUL character"));
		if (!IFileManager::Get().MakeDirectory(*Directory, true))
			return Fail(Error, TEXT("cannot create or access the storage directory"));
		const FString Path = FPaths::Combine(Directory, TEXT("workspace.lock"));
		// Keep this file permanently. Opening the same file through path aliases
		// still locks the same file object; deleting it could split the lock domain.
		Handle = ::CreateFileW(*Path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
			nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
		if (Handle == INVALID_HANDLE_VALUE) return WinError(Error, TEXT("Opening repository lock"));
		Locked = ::LockFileEx(Handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &Overlap) != 0;
		if (!Locked) return WinError(Error, TEXT("Acquiring repository lock; another editor may be saving"));
		return true;
	}
private:
	HANDLE Handle = INVALID_HANDLE_VALUE;
	OVERLAPPED Overlap = {};
	bool Locked = false;
};

bool ReadAscii(const FString& Path, FString& Out, bool& OutExists, FString& Error)
{
	HANDLE File = ::CreateFileW(*Path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (File == INVALID_HANDLE_VALUE)
	{
		const DWORD Code = ::GetLastError();
		if (Code == ERROR_FILE_NOT_FOUND) { OutExists = false; return true; }
		return WinError(Error, TEXT("Opening saved manifest"), Code);
	}
	LARGE_INTEGER Length = {};
	if (!::GetFileSizeEx(File, &Length))
	{
		const DWORD Code = ::GetLastError(); ::CloseHandle(File);
		return WinError(Error, TEXT("Reading manifest size"), Code);
	}
	if (Length.QuadPart <= 0 || Length.QuadPart > MaximumManifestBytes)
	{
		::CloseHandle(File);
		return Fail(Error, TEXT("manifest is empty or exceeds the 256 MiB R0 storage limit"));
	}
	TArray<uint8> Bytes;
	Bytes.SetNumUninitialized(static_cast<int32>(Length.QuadPart));
	int32 Offset = 0;
	while (Offset < Bytes.Num())
	{
		DWORD Read = 0;
		if (!::ReadFile(File, Bytes.GetData() + Offset, static_cast<DWORD>(Bytes.Num() - Offset), &Read, nullptr) || Read == 0)
		{
			const DWORD Code = ::GetLastError(); ::CloseHandle(File);
			return WinError(Error, TEXT("Reading saved manifest"), Code);
		}
		Offset += static_cast<int32>(Read);
	}
	::CloseHandle(File);
	FString Json;
	Json.Reserve(Bytes.Num());
	for (uint8 Byte : Bytes)
	{
		if (Byte < 0x20 || Byte > 0x7e) return Fail(Error, TEXT("manifest has invalid private-format bytes"));
		Json.AppendChar(static_cast<TCHAR>(Byte));
	}
	Out = MoveTemp(Json);
	OutExists = true;
	return true;
}

bool ReadManifest(const FString& Path, FManifest& Out, bool& OutExists, FString& Error)
{
	FString Json;
	bool Exists = false;
	if (!ReadAscii(Path, Json, Exists, Error)) return false;
	if (Exists)
	{
		if (!ParseManifest(Json, Out, Error)) return false;
		OutExists = true;
		return true;
	}
	// ReplaceFile documents a failure mode in which the old target has moved to
	// its backup name. Recover only a validated backup when the target is absent.
	// Never silently replace an existing but corrupt target with an older project.
	const FString Backup = Path + TEXT(".previous");
	if (!ReadAscii(Backup, Json, Exists, Error)) return false;
	if (!Exists) { Out = FManifest(); OutExists = false; return true; }
	FManifest Recovered;
	if (!ParseManifest(Json, Recovered, Error)) return false;
	if (!::MoveFileExW(*Backup, *Path, MOVEFILE_WRITE_THROUGH))
		return WinError(Error, TEXT("Restoring retained previous manifest"));
	Out = MoveTemp(Recovered);
	OutExists = true;
	return true;
}

class FTemporaryFile
{
public:
	FString Path;
	~FTemporaryFile() { if (!Path.IsEmpty()) ::DeleteFileW(*Path); }
};

bool Commit(const FString& Path, bool Existing, const FManifest& Manifest, FString& Error)
{
	const FString Json = ManifestJson(Manifest);
	if (Json.Len() > MaximumManifestBytes)
		return Fail(Error, TEXT("save exceeds the 256 MiB R0 storage limit; existing storage was not overwritten"));
	FTemporaryFile Temporary;
	Temporary.Path = Path + TEXT(".pending-") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	HANDLE File = ::CreateFileW(*Temporary.Path, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (File == INVALID_HANDLE_VALUE)
	{
		const DWORD Code = ::GetLastError();
		// A CREATE_NEW collision is not our file; never delete somebody else's data.
		Temporary.Path.Empty();
		return WinError(Error, TEXT("Creating temporary manifest"), Code);
	}
	TArray<uint8> Bytes;
	Bytes.Reserve(Json.Len());
	for (int32 I = 0; I < Json.Len(); ++I) Bytes.Add(static_cast<uint8>(Json[I]));
	int32 Offset = 0;
	while (Offset < Bytes.Num())
	{
		DWORD Written = 0;
		if (!::WriteFile(File, Bytes.GetData() + Offset, static_cast<DWORD>(Bytes.Num() - Offset), &Written, nullptr) || Written == 0)
		{
			const DWORD Code = ::GetLastError(); ::CloseHandle(File);
			return WinError(Error, TEXT("Writing temporary manifest"), Code);
		}
		Offset += static_cast<int32>(Written);
	}
	if (!::FlushFileBuffers(File))
	{
		const DWORD Code = ::GetLastError(); ::CloseHandle(File);
		return WinError(Error, TEXT("Flushing temporary manifest"), Code);
	}
	if (!::CloseHandle(File)) return WinError(Error, TEXT("Closing temporary manifest"));
	if (!Existing)
	{
		// Same-directory rename, without COPY_ALLOWED or REPLACE_EXISTING. A new
		// unexpected target is a failure, never permission to overwrite another save.
		if (!::MoveFileExW(*Temporary.Path, *Path, MOVEFILE_WRITE_THROUGH))
			return WinError(Error, TEXT("Committing new manifest"));
		Temporary.Path.Empty();
		return true;
	}
	const FString Backup = Path + TEXT(".previous");
	if (!::DeleteFileW(*Backup) && ::GetLastError() != ERROR_FILE_NOT_FOUND)
		return WinError(Error, TEXT("Preparing previous-manifest backup"));
	// REPLACEFILE_WRITE_THROUGH is explicitly unsupported by Windows. Flush the
	// new file first; retain a backup for documented partial replacement failures.
	// This is not a guarantee against every filesystem or hardware power failure.
	if (!::ReplaceFileW(*Path, *Temporary.Path, *Backup, 0, nullptr, nullptr))
	{
		const DWORD ReplaceError = ::GetLastError();
		const DWORD Attributes = ::GetFileAttributesW(*Path);
		const DWORD AttributeError = ::GetLastError();
		if (Attributes == INVALID_FILE_ATTRIBUTES && AttributeError == ERROR_FILE_NOT_FOUND)
		{
			if (!::MoveFileExW(*Backup, *Path, MOVEFILE_WRITE_THROUGH))
				return Fail(Error, FString::Printf(TEXT("replacement failed (%lu), and automatic restoration failed (%lu); retained backup: %s; export unsaved changes"),
					static_cast<unsigned long>(ReplaceError), static_cast<unsigned long>(::GetLastError()), *Backup));
		}
		return WinError(Error, TEXT("Replacing manifest; prior data retained"), ReplaceError);
	}
	Temporary.Path.Empty();
	// Commit is already complete. A backup cleanup failure does not turn a
	// committed generation into a reported failed save; the next save retries it.
	::DeleteFileW(*Backup);
	return true;
}
#endif
}

FSpatialPrevisWorkspaceRepository::FSpatialPrevisWorkspaceRepository(const FString& InRootDirectory)
{
	if (!InRootDirectory.IsEmpty())
	{
		RootDirectory = FPaths::ConvertRelativePathToFull(InRootDirectory);
		FPaths::NormalizeDirectoryName(RootDirectory);
	}
}

FString FSpatialPrevisWorkspaceRepository::GetManifestPath() const
{
	return FPaths::Combine(RootDirectory, TEXT("workspaces.v1.json"));
}

bool FSpatialPrevisWorkspaceRepository::Import(const FString& Json, FObject& OutState, FString& OutError)
{
	FObject State;
	if (!FSpatialPrevisWorkspaceCodec::Parse(Json, State, OutError)) return false;
	const FObject& Project = Field(State, TEXT("project"))->AsObject();
	for (const FValue& Value : Field(State, TEXT("checks"))->AsArray())
	{
		const FObject& Check = Value->AsObject();
		if (Same(String(Check, TEXT("status")), TEXT("stale"))) continue;
		TArray<FString> Scope;
		for (const FValue& Id : Field(Check, TEXT("scope"))->AsArray()) Scope.Add(Id->AsString());
		FString Hash;
		if (!FSpatialPrevisWorkspaceCodec::InputHash(Project, Scope, String(Check, TEXT("model")),
			String(Check, TEXT("modelVersion")), Hash, OutError)) return false;
		if (!Same(Hash, String(Check, TEXT("inputHash")))) Check->SetStringField(TEXT("status"), TEXT("stale"));
	}
	for (const FValue& Value : Field(State, TEXT("reviews"))->AsArray())
		Value->AsObject()->SetStringField(TEXT("status"), TEXT("stale"));
	OutState = MoveTemp(State);
	OutError.Empty();
	return true;
}

bool FSpatialPrevisWorkspaceRepository::Load(const FString& ProjectId, FObject& OutState,
	int64& OutGeneration, FString& OutError) const
{
#if PLATFORM_WINDOWS
	FRepositoryLock Lock;
	if (!Lock.Acquire(RootDirectory, OutError)) return false;
	FManifest Manifest;
	bool Exists = false;
	if (!ReadManifest(GetManifestPath(), Manifest, Exists, OutError)) return false;
	const int32 Index = Manifest.Find(ProjectId);
	if (Index == INDEX_NONE)
	{
		OutState.Reset(); OutGeneration = NewProjectGeneration; OutError.Empty(); return true;
	}
	FObject State;
	if (!Import(Manifest.Workspaces[Index].Json, State, OutError)) return false;
	OutState = MoveTemp(State);
	OutGeneration = Manifest.Workspaces[Index].Generation;
	OutError.Empty();
	return true;
#else
	return Fail(OutError, TEXT("the R0 durable repository is implemented for Windows only; portable import/export remains available"));
#endif
}

bool FSpatialPrevisWorkspaceRepository::LastProjectId(FString& OutId, FString& OutError) const
{
#if PLATFORM_WINDOWS
	FRepositoryLock Lock;
	if (!Lock.Acquire(RootDirectory, OutError)) return false;
	FManifest Manifest;
	bool Exists = false;
	if (!ReadManifest(GetManifestPath(), Manifest, Exists, OutError)) return false;
	OutId = Manifest.ActiveProjectId;
	OutError.Empty();
	return true;
#else
	return Fail(OutError, TEXT("the R0 durable repository is implemented for Windows only; portable import/export remains available"));
#endif
}

bool FSpatialPrevisWorkspaceRepository::Save(const FObject& State, int64 ExpectedGeneration,
	int64& OutNextGeneration, FString& OutError) const
{
	if (ExpectedGeneration != NewProjectGeneration && (ExpectedGeneration < 1 || ExpectedGeneration > MaximumGeneration))
		return Fail(OutError, TEXT("invalid expected generation"));
	FString Json;
	if (!FSpatialPrevisWorkspaceCodec::Serialize(State, Json, OutError)) return false;
#if PLATFORM_WINDOWS
	const FString ProjectId = String(Field(State, TEXT("project"))->AsObject(), TEXT("projectId"));
	FRepositoryLock Lock;
	if (!Lock.Acquire(RootDirectory, OutError)) return false;
	FManifest Manifest;
	bool Exists = false;
	if (!ReadManifest(GetManifestPath(), Manifest, Exists, OutError)) return false;
	const int32 Index = Manifest.Find(ProjectId);
	const int64 Previous = Index == INDEX_NONE ? NewProjectGeneration : Manifest.Workspaces[Index].Generation;
	if (Previous != ExpectedGeneration)
		return Fail(OutError, TEXT("save conflict: another editor saved this project; export your changes before reopening"));
	if (Previous == MaximumGeneration) return Fail(OutError, TEXT("generation limit reached; existing storage was not overwritten"));
	if (Index == INDEX_NONE && Manifest.Workspaces.Num() >= MaximumProjects)
		return Fail(OutError, TEXT("the 1024-project R0 repository limit was reached; existing storage was not overwritten"));
	FStoredWorkspace Entry;
	Entry.ProjectId = ProjectId;
	Entry.Generation = Previous == NewProjectGeneration ? 1 : Previous + 1;
	Entry.Json = MoveTemp(Json);
	const int64 Next = Entry.Generation;
	if (Index == INDEX_NONE) Manifest.Workspaces.Add(MoveTemp(Entry));
	else Manifest.Workspaces[Index] = MoveTemp(Entry);
	Manifest.ActiveProjectId = ProjectId;
	if (!Commit(GetManifestPath(), Exists, Manifest, OutError)) return false;
	OutNextGeneration = Next;
	OutError.Empty();
	return true;
#else
	return Fail(OutError, TEXT("the R0 durable repository is implemented for Windows only; portable import/export remains available"));
#endif
}
