#include "SpatialPrevisSocketMetadata.h"

#include "SpatialPrevisProjectCodec.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/Crc.h"
#include "Misc/Paths.h"

#include <charconv>
#include <cmath>
#include <limits>
#include <system_error>

#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#elif PLATFORM_UNIX
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace
{
using FObject = TSharedPtr<FJsonObject>;
using FValue = TSharedPtr<FJsonValue>;
constexpr double Pi = 3.14159265358979323846;
constexpr int32 MaximumFileBytes = 256 * 1024 * 1024;
constexpr int32 MaximumNodes = 100000;
constexpr int32 MaximumSockets = 100000;

bool Same(const FString& A, const FString& B)
{
	return A.Len() == B.Len() && (A.IsEmpty() || FMemory::Memcmp(*A, *B, A.Len() * sizeof(TCHAR)) == 0);
}
struct FExactSocketId
{
	FString Value;
	FExactSocketId() = default;
	explicit FExactSocketId(const FString& InValue) : Value(InValue) {}
	bool operator==(const FExactSocketId& Other) const { return Same(Value, Other.Value); }
	friend uint32 GetTypeHash(const FExactSocketId& Key)
	{
		return FCrc::MemCrc32(*Key.Value, Key.Value.Len() * sizeof(TCHAR));
	}
};
FValue Field(const FObject& Object, const TCHAR* Name)
{
	if (!Object.IsValid()) return nullptr;
	const FString Expected(Name);
	for (const auto& Entry : Object->Values)
		if (Same(FString(Entry.Key.Len(), *Entry.Key), Expected)) return Entry.Value;
	return nullptr;
}
bool Type(const FValue& Value, EJson Expected) { return Value.IsValid() && Value->Type == Expected; }
FObject Object(const FValue& Value) { return Type(Value, EJson::Object) ? Value->AsObject() : nullptr; }
bool Nullish(const FValue& Value) { return !Value.IsValid() || Value->Type == EJson::Null; }
FValue Fallback(const FValue& First, const FValue& Second) { return Nullish(First) ? Second : First; }
bool Fail(FString& Error, const FString& Message) { Error = TEXT("Socket metadata: ") + Message; return false; }
bool Finite(const FVector3d& V) { return std::isfinite(V.X) && std::isfinite(V.Y) && std::isfinite(V.Z); }

bool Tuple(const FValue& Value, int32 Count, double* Out)
{
	if (!Type(Value, EJson::Array) || Value->AsArray().Num() != Count) return false;
	for (int32 I = 0; I < Count; ++I)
	{
		const FValue& Component = Value->AsArray()[I];
		if (!Type(Component, EJson::Number) || !std::isfinite(Component->AsNumber())) return false;
		Out[I] = Component->AsNumber();
	}
	return true;
}
bool Vector(const FValue& Value, FVector3d& Out)
{
	double V[3];
	if (!Tuple(Value, 3, V)) return false;
	Out = FVector3d(V[0], V[1], V[2]);
	return true;
}

FString SocketType(const FValue& Raw)
{
	if (!Type(Raw, EJson::String)) return FString();
	const FString Text = Raw->AsString();
	const FString Upper = Text.ToUpper();
	static const TCHAR* Types[] = {
		TEXT("TRUSS_CONICAL_F34"), TEXT("TRUSS_CONICAL_F44"), TEXT("STAGE_COFFIN_LOCK"),
		TEXT("STAGE_LEG_RECEIVER"), TEXT("LED_PANEL_FASTENER"), TEXT("LED_FLYBAR_PICKUP"),
		TEXT("PIPE_CLAMP_2IN"), TEXT("RIG_HOIST_HOOK"), TEXT("SPEAKER_ARRAY_PIN"),
		TEXT("GROUND_SUPPORT_BASE"), TEXT("SFX_MOUNT"), TEXT("BARRICADE_HINGE")
	};
	for (const TCHAR* Candidate : Types) if (Same(Upper, Candidate)) return Candidate;
	if (Same(Text, TEXT("truss_f34_chord"))) return TEXT("TRUSS_CONICAL_F34");
	if (Same(Text, TEXT("truss_f44_chord"))) return TEXT("TRUSS_CONICAL_F44");
	if (Same(Text, TEXT("deck_coffin_lock"))) return TEXT("STAGE_COFFIN_LOCK");
	if (Same(Text, TEXT("deck_leg"))) return TEXT("STAGE_LEG_RECEIVER");
	if (Same(Text, TEXT("ground_support_base"))) return TEXT("GROUND_SUPPORT_BASE");
	return FString();
}

bool TrimSpace(TCHAR Character)
{
	const uint32 C = static_cast<uint32>(Character);
	return (C >= 0x09 && C <= 0x0d) || C == 0x20 || C == 0xa0 || C == 0x1680 ||
		(C >= 0x2000 && C <= 0x200a) || C == 0x2028 || C == 0x2029 || C == 0x202f ||
		C == 0x205f || C == 0x3000 || C == 0xfeff;
}

// Detent subtraction in JavaScript coerces its two operands. Preserve that
// behavior even for legacy JSON primitive/single-element-array detent values.
double Numeric(const FValue& Value, int32 Depth = 0)
{
	const double NaN = std::numeric_limits<double>::quiet_NaN();
	if (!Value.IsValid() || Depth > 128) return NaN;
	if (Value->Type == EJson::Null) return 0;
	if (Value->Type == EJson::Number) return Value->AsNumber();
	if (Value->Type == EJson::Boolean) return Value->AsBool() ? 1 : 0;
	if (Value->Type == EJson::Array)
	{
		const TArray<FValue>& Values = Value->AsArray();
		if (Values.IsEmpty()) return 0;
		if (Values.Num() != 1) return NaN;
		// Array.toString turns a boolean into "true"/"false", not 1/0.
		if (Type(Values[0], EJson::Boolean)) return NaN;
		return Numeric(Values[0], Depth + 1);
	}
	if (Value->Type != EJson::String) return NaN;
	const FString Input = Value->AsString();
	int32 First = 0, Last = Input.Len();
	while (First < Last && TrimSpace(Input[First])) ++First;
	while (Last > First && TrimSpace(Input[Last - 1])) --Last;
	const FString Text = Input.Mid(First, Last - First);
	if (Text.IsEmpty()) return 0;
	if (Same(Text, TEXT("Infinity")) || Same(Text, TEXT("+Infinity"))) return std::numeric_limits<double>::infinity();
	if (Same(Text, TEXT("-Infinity"))) return -std::numeric_limits<double>::infinity();
	if (Text.Len() > 2 && Text[0] == '0')
	{
		const TCHAR Prefix = Text[1];
		const int32 Base = (Prefix == 'x' || Prefix == 'X') ? 16 : (Prefix == 'o' || Prefix == 'O') ? 8 :
			(Prefix == 'b' || Prefix == 'B') ? 2 : 0;
		if (Base != 0)
		{
			double Result = 0;
			for (int32 I = 2; I < Text.Len(); ++I)
			{
				const TCHAR C = Text[I];
				const int32 Digit = C >= '0' && C <= '9' ? C - '0' : C >= 'a' && C <= 'f' ? C - 'a' + 10 :
					C >= 'A' && C <= 'F' ? C - 'A' + 10 : -1;
				if (Digit < 0 || Digit >= Base) return NaN;
				Result = Result * Base + Digit;
			}
			return Result;
		}
	}
	int32 I = (Text[0] == '+' || Text[0] == '-') ? 1 : 0;
	int32 Digits = 0;
	while (I < Text.Len() && Text[I] >= '0' && Text[I] <= '9') { ++I; ++Digits; }
	if (I < Text.Len() && Text[I] == '.')
	{
		++I;
		while (I < Text.Len() && Text[I] >= '0' && Text[I] <= '9') { ++I; ++Digits; }
	}
	if (Digits == 0) return NaN;
	if (I < Text.Len() && (Text[I] == 'e' || Text[I] == 'E'))
	{
		++I;
		if (I < Text.Len() && (Text[I] == '+' || Text[I] == '-')) ++I;
		const int32 Start = I;
		while (I < Text.Len() && Text[I] >= '0' && Text[I] <= '9') ++I;
		if (I == Start) return NaN;
	}
	if (I != Text.Len()) return NaN;
	// from_chars is locale independent. The spelling above may include a leading
	// plus, which JavaScript permits and from_chars does not.
	TArray<char> Ascii;
	for (int32 J = Text[0] == '+' ? 1 : 0; J < Text.Len(); ++J) Ascii.Add(static_cast<char>(Text[J]));
	double Result = 0;
	const auto Parsed = std::from_chars(Ascii.GetData(), Ascii.GetData() + Ascii.Num(), Result);
	if (Parsed.ec == std::errc()) return Result;
	if (Parsed.ec != std::errc::result_out_of_range) return NaN;
	// Out-of-range conversion is either overflow to infinity or underflow to
	// signed zero. Classify using decimal order without overflowing an exponent.
	int32 Exponent = 0, ExponentSign = 1, BeforePoint = 0, DigitCount = 0, FirstNonzero = INDEX_NONE;
	bool AfterPoint = false, ReadingExponent = false;
	for (int32 J = (Text[0] == '+' || Text[0] == '-') ? 1 : 0; J < Text.Len(); ++J)
	{
		const TCHAR C = Text[J];
		if (C == 'e' || C == 'E') { ReadingExponent = true; continue; }
		if (ReadingExponent)
		{
			if (C == '-') ExponentSign = -1;
			else if (C != '+') Exponent = FMath::Min(1000000, Exponent * 10 + C - '0');
		}
		else if (C == '.') AfterPoint = true;
		else
		{
			if (!AfterPoint) ++BeforePoint;
			if (C != '0' && FirstNonzero == INDEX_NONE) FirstNonzero = DigitCount;
			++DigitCount;
		}
	}
	const bool Underflow = FirstNonzero == INDEX_NONE || Exponent * ExponentSign + BeforePoint - FirstNonzero - 1 < -308;
	return std::copysign(Underflow ? 0.0 : std::numeric_limits<double>::infinity(), Text[0] == '-' ? -1.0 : 1.0);
}

struct FSharedMatrix
{
	double M[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
	FSharedMatrix Multiply(const FSharedMatrix& B) const
	{
		FSharedMatrix Result;
		for (int32 Column = 0; Column < 4; ++Column)
			for (int32 Row = 0; Row < 4; ++Row)
				Result.M[Column * 4 + Row] = M[Row] * B.M[Column * 4] + M[4 + Row] * B.M[Column * 4 + 1] +
					M[8 + Row] * B.M[Column * 4 + 2] + M[12 + Row] * B.M[Column * 4 + 3];
		return Result;
	}
	FVector3d Position(const FVector3d& V) const
	{
		const double W = 1.0 / (M[3] * V.X + M[7] * V.Y + M[11] * V.Z + M[15]);
		return FVector3d((M[0] * V.X + M[4] * V.Y + M[8] * V.Z + M[12]) * W,
			(M[1] * V.X + M[5] * V.Y + M[9] * V.Z + M[13]) * W,
			(M[2] * V.X + M[6] * V.Y + M[10] * V.Z + M[14]) * W);
	}
	FVector3d Direction(const FVector3d& V) const
	{
		FVector3d Result(M[0] * V.X + M[4] * V.Y + M[8] * V.Z,
			M[1] * V.X + M[5] * V.Y + M[9] * V.Z, M[2] * V.X + M[6] * V.Y + M[10] * V.Z);
		const double Length = std::sqrt(Result.X * Result.X + Result.Y * Result.Y + Result.Z * Result.Z);
		// Three.Vector3.normalize divides by (length || 1), preserving zero.
		if (Length != 0) Result /= Length;
		return Result;
	}
};

bool NodeMatrix(const FObject& Node, FSharedMatrix& Out, FString& Error)
{
	const FValue Matrix = Field(Node, TEXT("matrix"));
	if (Matrix.IsValid())
	{
		if (Field(Node, TEXT("translation")).IsValid() || Field(Node, TEXT("rotation")).IsValid() || Field(Node, TEXT("scale")).IsValid())
			return Fail(Error, TEXT("node cannot define matrix and TRS together"));
		if (!Tuple(Matrix, 16, Out.M)) return Fail(Error, TEXT("node matrix must contain 16 finite numbers"));
		return true;
	}
	double T[3] = {0,0,0}, Q[4] = {0,0,0,1}, S[3] = {1,1,1};
	if ((Field(Node, TEXT("translation")).IsValid() && !Tuple(Field(Node, TEXT("translation")), 3, T)) ||
		(Field(Node, TEXT("rotation")).IsValid() && !Tuple(Field(Node, TEXT("rotation")), 4, Q)) ||
		(Field(Node, TEXT("scale")).IsValid() && !Tuple(Field(Node, TEXT("scale")), 3, S)))
		return Fail(Error, TEXT("node TRS has an invalid numeric tuple"));
	// glTF and Three.Matrix4.compose: column vectors, T * R * S, quaternion xyzw.
	const double X2 = Q[0] + Q[0], Y2 = Q[1] + Q[1], Z2 = Q[2] + Q[2];
	const double XX = Q[0] * X2, XY = Q[0] * Y2, XZ = Q[0] * Z2;
	const double YY = Q[1] * Y2, YZ = Q[1] * Z2, ZZ = Q[2] * Z2;
	const double WX = Q[3] * X2, WY = Q[3] * Y2, WZ = Q[3] * Z2;
	Out.M[0] = (1 - (YY + ZZ)) * S[0]; Out.M[1] = (XY + WZ) * S[0]; Out.M[2] = (XZ - WY) * S[0];
	Out.M[4] = (XY - WZ) * S[1]; Out.M[5] = (1 - (XX + ZZ)) * S[1]; Out.M[6] = (YZ + WX) * S[1];
	Out.M[8] = (XZ + WY) * S[2]; Out.M[9] = (YZ - WX) * S[2]; Out.M[10] = (1 - (XX + YY)) * S[2];
	Out.M[12] = T[0]; Out.M[13] = T[1]; Out.M[14] = T[2];
	return true;
}

bool Index(const FValue& Value, int32 Count, int32& Out)
{
	if (!Type(Value, EJson::Number)) return false;
	const double N = Value->AsNumber();
	if (!std::isfinite(N) || N < 0 || N >= Count || std::floor(N) != N) return false;
	Out = static_cast<int32>(N); return true;
}

bool AppendSockets(const FObject& Owner, const FSharedMatrix* Transform, TArray<FSpatialPrevisSocket>& Out,
	TSet<FExactSocketId>& Ids, FString& Error)
{
	const FObject Extras = Object(Field(Owner, TEXT("extras")));
	// GLTFLoader flattens node.extras into userData. Also honor nested extras,
	// whose precedence is the same as readSockets(userData.extras ?? userData).
	const FObject Nested = Object(Field(Extras, TEXT("extras")));
	const FValue Sockets = Fallback(Field(Nested, TEXT("sockets")), Field(Extras, TEXT("sockets")));
	if (!Type(Sockets, EJson::Array)) return true;
	for (const FValue& Raw : Sockets->AsArray())
	{
		FSpatialPrevisSocket Socket;
		FString NormalizeError;
		if (!FSpatialPrevisSocketMetadata::Normalize(Object(Raw), Socket, NormalizeError))
		{
			UE_LOG(LogTemp, Warning, TEXT("%s; skipping malformed glTF socket, matching the web reader"), *NormalizeError);
			continue;
		}
		if (Ids.Contains(FExactSocketId(Socket.Id))) return Fail(Error, TEXT("duplicate asset socket ID"));
		if (Transform)
		{
			Socket.Position = Transform->Position(Socket.Position);
			Socket.Normal = Transform->Direction(Socket.Normal);
			Socket.Up = Transform->Direction(Socket.Up);
			if (!Finite(Socket.Position) || !Finite(Socket.Normal) || !Finite(Socket.Up))
				return Fail(Error, TEXT("node transform produced nonfinite socket coordinates"));
			// liftSockets writes degrees back to metadata before readSockets
			// normalizes again. Preserve its floating-point conversion order.
			Socket.SnapAngleRadians = (Socket.SnapAngleRadians * (180.0 / Pi) * Pi) / 180.0;
			const double Step = (std::abs(Socket.DetentStepRadians * (180.0 / Pi)) * Pi) / 180.0;
			Socket.DetentStepRadians = Step > SpatialPrevisSocketDefaults::DirectionEpsilon ? Step : SpatialPrevisSocketDefaults::DetentStepRadians;
		}
		if (Out.Num() >= MaximumSockets) return Fail(Error, TEXT("asset exceeds the 100000-socket R0 limit"));
		Ids.Add(FExactSocketId(Socket.Id));
		Out.Add(MoveTemp(Socket));
	}
	return true;
}

bool Utf8(const uint8* Bytes, int32 Count, FString& Out, FString& Error)
{
	FString Result;
	int32 I = Count >= 3 && Bytes[0] == 0xef && Bytes[1] == 0xbb && Bytes[2] == 0xbf ? 3 : 0;
	while (I < Count)
	{
		const uint8 First = Bytes[I++];
		uint32 Scalar = First; int32 Extra = 0; uint32 Minimum = 0;
		if (First >= 0xc2 && First <= 0xdf) { Scalar = First & 0x1f; Extra = 1; Minimum = 0x80; }
		else if (First >= 0xe0 && First <= 0xef) { Scalar = First & 0x0f; Extra = 2; Minimum = 0x800; }
		else if (First >= 0xf0 && First <= 0xf4) { Scalar = First & 0x07; Extra = 3; Minimum = 0x10000; }
		else if (First > 0x7f) return Fail(Error, TEXT("model JSON contains invalid UTF-8"));
		for (int32 J = 0; J < Extra; ++J)
		{
			if (I == Count || (Bytes[I] & 0xc0) != 0x80) return Fail(Error, TEXT("model JSON contains invalid UTF-8"));
			Scalar = (Scalar << 6) | (Bytes[I++] & 0x3f);
		}
		if (Scalar < Minimum || Scalar > 0x10ffff || (Scalar >= 0xd800 && Scalar <= 0xdfff))
			return Fail(Error, TEXT("model JSON contains invalid UTF-8"));
		if (sizeof(TCHAR) == 2 && Scalar > 0xffff)
		{
			Scalar -= 0x10000;
			Result.AppendChar(static_cast<TCHAR>(0xd800 + (Scalar >> 10)));
			Result.AppendChar(static_cast<TCHAR>(0xdc00 + (Scalar & 0x3ff)));
		}
		else Result.AppendChar(static_cast<TCHAR>(Scalar));
	}
	Out = MoveTemp(Result); return true;
}

uint32 U32(const uint8* P) { return uint32(P[0]) | (uint32(P[1]) << 8) | (uint32(P[2]) << 16) | (uint32(P[3]) << 24); }

bool JsonChunk(const TArray<uint8>& Bytes, bool IsGlb, FString& Out, FString& Error)
{
	if (!IsGlb) return Utf8(Bytes.GetData(), Bytes.Num(), Out, Error);
	if (Bytes.Num() < 20 || U32(Bytes.GetData()) != 0x46546c67 || U32(Bytes.GetData() + 4) != 2 ||
		U32(Bytes.GetData() + 8) != static_cast<uint32>(Bytes.Num()))
		return Fail(Error, TEXT("invalid GLB 2 header or total length"));
	int32 Offset = 12, ChunkNumber = 0;
	FString Json;
	bool SeenJson = false, SeenBin = false;
	while (Offset < Bytes.Num())
	{
		if (Bytes.Num() - Offset < 8) return Fail(Error, TEXT("truncated GLB chunk header"));
		const uint32 Length = U32(Bytes.GetData() + Offset), Kind = U32(Bytes.GetData() + Offset + 4);
		Offset += 8;
		if (Length % 4 != 0 || Length > static_cast<uint32>(Bytes.Num() - Offset))
			return Fail(Error, TEXT("invalid GLB chunk length/alignment"));
		if (Kind == 0x4e4f534a)
		{
			if (SeenJson || ChunkNumber != 0) return Fail(Error, TEXT("GLB must have exactly one first JSON chunk"));
			if (!Utf8(Bytes.GetData() + Offset, static_cast<int32>(Length), Json, Error)) return false;
			SeenJson = true;
		}
		else if (Kind == 0x004e4942)
		{
			if (SeenBin || ChunkNumber != 1) return Fail(Error, TEXT("GLB BIN chunk must be second and unique"));
			SeenBin = true;
		}
		else if (ChunkNumber == 0) return Fail(Error, TEXT("GLB first chunk is not JSON"));
		Offset += static_cast<int32>(Length); ++ChunkNumber;
	}
	if (!SeenJson) return Fail(Error, TEXT("GLB JSON chunk is missing"));
	Out = MoveTemp(Json); return true;
}

bool UriSegments(const FString& Uri, TArray<FString>& Out, FString& Error)
{
	if (Uri.IsEmpty() || Uri[0] == '/' || Uri[0] == '\\') return Fail(Error, TEXT("model URI must be relative to the asset root"));
	for (int32 I = 0; I < Uri.Len(); ++I)
		if (Uri[I] < 0x20 || Uri[I] == '\\' || Uri[I] == ':' || Uri[I] == '?' || Uri[I] == '#' || Uri[I] == '%' ||
			Uri[I] == '"' || Uri[I] == '<' || Uri[I] == '>' || Uri[I] == '|' || Uri[I] == '*')
			return Fail(Error, TEXT("model URI must be a plain local path, without a URL, encoding, or special path syntax"));
	Uri.ParseIntoArray(Out, TEXT("/"), false);
	for (const FString& Part : Out)
		if (Part.IsEmpty() || Same(Part, TEXT(".")) || Same(Part, TEXT("..")) || Part[Part.Len() - 1] == '.' || Part[Part.Len() - 1] == ' ')
			return Fail(Error, TEXT("model URI has an ambiguous or escaping path component"));
	return true;
}

#if PLATFORM_WINDOWS
class FLocalSocketHandle
{
public:
	HANDLE Value = INVALID_HANDLE_VALUE;
	~FLocalSocketHandle() { if (Value != INVALID_HANDLE_VALUE) ::CloseHandle(Value); }
};
bool FinalPath(HANDLE Handle, FString& Out)
{
	const DWORD Required = ::GetFinalPathNameByHandleW(Handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	if (Required == 0 || Required > 32768) return false;
	TArray<WCHAR> Buffer; Buffer.SetNumUninitialized(static_cast<int32>(Required + 1));
	const DWORD Length = ::GetFinalPathNameByHandleW(Handle, Buffer.GetData(), Required + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	if (Length == 0 || Length > Required) return false;
	Out = FString(static_cast<int32>(Length), Buffer.GetData()); return true;
}
#endif

bool ReadLocal(const FString& Uri, const FString& Root, const TArray<FString>& Parts, TArray<uint8>& Out, FString& Error)
{
	if (Root.IsEmpty()) return Fail(Error, TEXT("asset root is required"));
	for (int32 I = 0; I < Root.Len(); ++I) if (Root[I] == 0) return Fail(Error, TEXT("asset root contains NUL"));
#if PLATFORM_WINDOWS
	const FString FullRoot = FPaths::ConvertRelativePathToFull(Root);
	FLocalSocketHandle RootHandle, File;
	RootHandle.Value = ::CreateFileW(*FullRoot, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
		nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
	if (RootHandle.Value == INVALID_HANDLE_VALUE) return Fail(Error, TEXT("cannot open the local asset root"));
	const FString Path = FPaths::Combine(FullRoot, Uri);
	File.Value = ::CreateFileW(*Path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
		FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
	if (File.Value == INVALID_HANDLE_VALUE) return Fail(Error, TEXT("cannot open the local model file"));
	BY_HANDLE_FILE_INFORMATION Info = {};
	if (!::GetFileInformationByHandle(File.Value, &Info) || (Info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
		::GetFileType(File.Value) != FILE_TYPE_DISK)
		return Fail(Error, TEXT("model must be a regular local file"));
	FString ActualRoot, ActualFile;
	if (!FinalPath(RootHandle.Value, ActualRoot) || !FinalPath(File.Value, ActualFile))
		return Fail(Error, TEXT("cannot verify the model file's resolved path"));
	if (!ActualRoot.EndsWith(TEXT("\\"))) ActualRoot += TEXT("\\");
	// Resolve the OPEN handles, then read that same handle: junction/symlink path
	// races cannot swap the verified target for a file outside the asset root.
	if (ActualFile.Len() <= ActualRoot.Len() || !Same(ActualFile.Left(ActualRoot.Len()), ActualRoot) ||
		ActualFile.StartsWith(TEXT("\\\\?\\UNC\\"), ESearchCase::IgnoreCase))
		return Fail(Error, TEXT("model resolves outside the local asset root"));
	LARGE_INTEGER Size = {};
	if (!::GetFileSizeEx(File.Value, &Size) || Size.QuadPart <= 0 || Size.QuadPart > MaximumFileBytes)
		return Fail(Error, TEXT("model is empty or exceeds the 256 MiB R0 metadata-read limit"));
	TArray<uint8> Bytes; Bytes.SetNumUninitialized(static_cast<int32>(Size.QuadPart));
	int32 Offset = 0;
	while (Offset < Bytes.Num())
	{
		DWORD Read = 0;
		if (!::ReadFile(File.Value, Bytes.GetData() + Offset, static_cast<DWORD>(Bytes.Num() - Offset), &Read, nullptr) || Read == 0)
			return Fail(Error, TEXT("model read was incomplete"));
		Offset += static_cast<int32>(Read);
	}
	Out = MoveTemp(Bytes); return true;
#elif PLATFORM_UNIX
	// Descend using directory handles and refuse symlinks at every relative
	// component; no process-global cwd or check-then-open path resolution is used.
	int Current = ::open(TCHAR_TO_UTF8(*Root), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (Current < 0) return Fail(Error, TEXT("cannot open the local asset root"));
	for (int32 I = 0; I < Parts.Num(); ++I)
	{
		const int Flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | (I + 1 == Parts.Num() ? 0 : O_DIRECTORY);
		const int Next = ::openat(Current, TCHAR_TO_UTF8(*Parts[I]), Flags);
		::close(Current); Current = Next;
		if (Current < 0) return Fail(Error, TEXT("cannot open model beneath asset root; symlinks are not followed"));
	}
	struct stat Info = {};
	if (::fstat(Current, &Info) != 0 || !S_ISREG(Info.st_mode) || Info.st_size <= 0 || Info.st_size > MaximumFileBytes)
	{
		::close(Current); return Fail(Error, TEXT("model must be a regular nonempty file no larger than 256 MiB"));
	}
	TArray<uint8> Bytes; Bytes.SetNumUninitialized(static_cast<int32>(Info.st_size));
	int32 Offset = 0;
	while (Offset < Bytes.Num())
	{
		const ssize_t Count = ::read(Current, Bytes.GetData() + Offset, Bytes.Num() - Offset);
		if (Count <= 0) { ::close(Current); return Fail(Error, TEXT("model read was incomplete")); }
		Offset += static_cast<int32>(Count);
	}
	::close(Current); Out = MoveTemp(Bytes); return true;
#else
	return Fail(Error, TEXT("local model-file loading is not implemented on this platform"));
#endif
}
}

bool FSpatialPrevisSocketMetadata::Normalize(const FObject& Raw, FSpatialPrevisSocket& OutSocket, FString& OutError)
{
	if (!Raw.IsValid()) return Fail(OutError, TEXT("socket must be an object"));
	FSpatialPrevisSocket Socket;
	const FValue Id = Field(Raw, TEXT("socket_id")), Gender = Field(Raw, TEXT("gender"));
	Socket.Type = SocketType(Field(Raw, TEXT("socket_type")));
	if (!Type(Id, EJson::String) || Socket.Type.IsEmpty() || !Type(Gender, EJson::String))
		return Fail(OutError, TEXT("invalid socket ID, type or gender"));
	Socket.Id = Id->AsString(); Socket.Gender = Gender->AsString().ToUpper();
	if (!Same(Socket.Gender, TEXT("MALE")) && !Same(Socket.Gender, TEXT("FEMALE")) &&
		!Same(Socket.Gender, TEXT("NEUTRAL")) && !Same(Socket.Gender, TEXT("UNIVERSAL")))
		return Fail(OutError, TEXT("invalid socket gender"));
	const FObject Transform = Object(Field(Raw, TEXT("transform")));
	if (!Vector(Fallback(Field(Transform, TEXT("translation")), Field(Raw, TEXT("position"))), Socket.Position) ||
		!Vector(Fallback(Field(Transform, TEXT("normal")), Field(Raw, TEXT("normal"))), Socket.Normal) ||
		!Vector(Fallback(Field(Transform, TEXT("up")), Field(Raw, TEXT("up"))), Socket.Up))
		return Fail(OutError, TEXT("socket position, normal and up must be finite three-tuples"));
	const FObject Tolerances = Object(Field(Raw, TEXT("tolerances"))), Rules = Object(Field(Raw, TEXT("kinematic_rules")));
	const FValue Radius = Field(Tolerances, TEXT("snap_radius")), Angle = Field(Tolerances, TEXT("snap_angle"));
	if (Type(Radius, EJson::Number)) Socket.SnapRadius = Radius->AsNumber();
	if (Type(Angle, EJson::Number)) Socket.SnapAngleRadians = (Angle->AsNumber() * Pi) / 180.0;
	const FValue Detents = Field(Tolerances, TEXT("detents_deg"));
	if (Type(Detents, EJson::Array) && Detents->AsArray().Num() > 1)
	{
		const double Step = (std::abs(Numeric(Detents->AsArray()[1]) - Numeric(Detents->AsArray()[0])) * Pi) / 180.0;
		if (Step > SpatialPrevisSocketDefaults::DirectionEpsilon) Socket.DetentStepRadians = Step;
	}
	const FValue Parent = Field(Rules, TEXT("can_parent")), Child = Field(Rules, TEXT("can_child")), Bearing = Field(Rules, TEXT("load_bearing"));
	Socket.bCanParent = !Type(Parent, EJson::Boolean) || Parent->AsBool();
	Socket.bCanChild = !Type(Child, EJson::Boolean) || Child->AsBool();
	Socket.bLoadBearing = Type(Bearing, EJson::Boolean) && Bearing->AsBool();
	const FValue Load = Field(Rules, TEXT("max_load_kg")), LegacyLoad = Field(Raw, TEXT("load_rating_kg"));
	if (Type(Load, EJson::Number)) Socket.MaxLoadKg = Load->AsNumber();
	else if (Type(LegacyLoad, EJson::Number)) Socket.MaxLoadKg = LegacyLoad->AsNumber();
	const FValue Tags = Field(Raw, TEXT("tags"));
	if (Type(Tags, EJson::Array))
		for (const FValue& Tag : Tags->AsArray()) if (Type(Tag, EJson::String)) Socket.Tags.Add(Tag->AsString());
	OutSocket = MoveTemp(Socket); OutError.Empty(); return true;
}

bool FSpatialPrevisSocketMetadata::ParseGltf(const FString& Json, TArray<FSpatialPrevisSocket>& OutSockets, FString& OutError)
{
	FValue Parsed;
	if (!FSpatialPrevisProjectCodec::ParseJson(Json, Parsed, OutError)) return false;
	const FObject Root = Object(Parsed), Asset = Object(Field(Root, TEXT("asset")));
	if (!Type(Field(Asset, TEXT("version")), EJson::String) || !Same(Field(Asset, TEXT("version"))->AsString(), TEXT("2.0")))
		return Fail(OutError, TEXT("only glTF asset version 2.0 is supported"));
	const FValue NodesValue = Field(Root, TEXT("nodes")), ScenesValue = Field(Root, TEXT("scenes"));
	if ((NodesValue.IsValid() && !Type(NodesValue, EJson::Array)) || !Type(ScenesValue, EJson::Array) || ScenesValue->AsArray().IsEmpty())
		return Fail(OutError, TEXT("glTF must provide a scene and valid nodes"));
	const TArray<FValue> Empty;
	const TArray<FValue>& Nodes = NodesValue.IsValid() ? NodesValue->AsArray() : Empty;
	if (Nodes.Num() > MaximumNodes) return Fail(OutError, TEXT("glTF exceeds the 100000-node R0 limit"));
	TArray<FSharedMatrix> Locals; Locals.SetNum(Nodes.Num());
	TArray<TArray<int32>> Children; Children.SetNum(Nodes.Num());
	TArray<int32> Parents; Parents.Init(INDEX_NONE, Nodes.Num());
	for (int32 I = 0; I < Nodes.Num(); ++I)
	{
		const FObject Node = Object(Nodes[I]);
		if (!Node.IsValid()) return Fail(OutError, TEXT("glTF node must be an object"));
		if (!NodeMatrix(Node, Locals[I], OutError)) return false;
		const FValue ChildValues = Field(Node, TEXT("children"));
		if (ChildValues.IsValid() && !Type(ChildValues, EJson::Array)) return Fail(OutError, TEXT("node children must be an index array"));
		if (ChildValues.IsValid()) for (const FValue& ChildValue : ChildValues->AsArray())
		{
			int32 Child;
			if (!Index(ChildValue, Nodes.Num(), Child)) return Fail(OutError, TEXT("node child index is invalid"));
			if (Parents[Child] != INDEX_NONE) return Fail(OutError, TEXT("node has duplicate or multiple parents"));
			Parents[Child] = I; Children[I].Add(Child);
		}
	}
	// Parent-chain colors reject cycles even in nodes outside the selected scene.
	TArray<uint8> Colors; Colors.Init(0, Nodes.Num());
	for (int32 Start = 0; Start < Nodes.Num(); ++Start)
	{
		int32 Current = Start;
		while (Current != INDEX_NONE && Colors[Current] == 0) { Colors[Current] = 1; Current = Parents[Current]; }
		if (Current != INDEX_NONE && Colors[Current] == 1) return Fail(OutError, TEXT("cyclic glTF node hierarchy"));
		Current = Start;
		while (Current != INDEX_NONE && Colors[Current] == 1) { Colors[Current] = 2; Current = Parents[Current]; }
	}
	int32 SceneIndex = 0;
	const FValue DefaultScene = Field(Root, TEXT("scene"));
	if (DefaultScene.IsValid() && !Index(DefaultScene, ScenesValue->AsArray().Num(), SceneIndex))
		return Fail(OutError, TEXT("default scene index is invalid"));
	const FObject Scene = Object(ScenesValue->AsArray()[SceneIndex]);
	if (!Scene.IsValid()) return Fail(OutError, TEXT("default scene must be an object"));
	TArray<FSpatialPrevisSocket> Sockets;
	TSet<FExactSocketId> SocketIds;
	if (!AppendSockets(Scene, nullptr, Sockets, SocketIds, OutError)) return false;
	const bool RootHasSockets = !Sockets.IsEmpty();
	const FValue RootNodes = Field(Scene, TEXT("nodes"));
	if (RootNodes.IsValid() && !Type(RootNodes, EJson::Array)) return Fail(OutError, TEXT("scene nodes must be an index array"));
	struct FVisit { int32 Index; FSharedMatrix World; };
	TArray<FVisit> Stack;
	TSet<int32> SeenRoots;
	if (RootNodes.IsValid())
		for (int32 I = RootNodes->AsArray().Num() - 1; I >= 0; --I)
		{
			int32 Node;
			if (!Index(RootNodes->AsArray()[I], Nodes.Num(), Node) || Parents[Node] != INDEX_NONE || SeenRoots.Contains(Node))
				return Fail(OutError, TEXT("invalid, duplicate, or non-root scene node"));
			SeenRoots.Add(Node); Stack.Add({Node, Locals[Node]});
		}
	while (!Stack.IsEmpty())
	{
		const FVisit Visit = Stack.Pop(EAllowShrinking::No);
		if (!RootHasSockets && !AppendSockets(Object(Nodes[Visit.Index]), &Visit.World, Sockets, SocketIds, OutError)) return false;
		for (int32 I = Children[Visit.Index].Num() - 1; I >= 0; --I)
		{
			const int32 Child = Children[Visit.Index][I];
			Stack.Add({Child, Visit.World.Multiply(Locals[Child])});
		}
	}
	OutSockets = MoveTemp(Sockets); OutError.Empty(); return true;
}

bool FSpatialPrevisSocketMetadata::Load(const FString& ModelUri, const FString& AssetRoot,
	TArray<FSpatialPrevisSocket>& OutSockets, FString& OutError)
{
	TArray<FString> Parts;
	if (!UriSegments(ModelUri, Parts, OutError)) return false;
	const FString Extension = FPaths::GetExtension(ModelUri).ToLower();
	if (!Same(Extension, TEXT("glb")) && !Same(Extension, TEXT("gltf"))) return Fail(OutError, TEXT("model must be a .glb or .gltf file"));
	TArray<uint8> Bytes;
	if (!ReadLocal(ModelUri, AssetRoot, Parts, Bytes, OutError)) return false;
	FString Json;
	if (!JsonChunk(Bytes, Same(Extension, TEXT("glb")), Json, OutError)) return false;
	return ParseGltf(Json, OutSockets, OutError);
}
