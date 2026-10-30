import ctypes
import ctypes.util
import hashlib
import json
import sys
from pathlib import Path


class FontName(ctypes.Structure):
    _fields_ = [
        ("platform_id", ctypes.c_ushort), ("encoding_id", ctypes.c_ushort),
        ("language_id", ctypes.c_ushort), ("name_id", ctypes.c_ushort),
        ("string", ctypes.POINTER(ctypes.c_ubyte)), ("string_len", ctypes.c_uint),
    ]


def collect_fonts(root):
    library_name = ctypes.util.find_library("freetype")
    if not library_name:
        raise RuntimeError("FreeType is required to preserve bundled font notices (install libfreetype6).")
    library = ctypes.CDLL(library_name)
    library.FT_Init_FreeType.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    library.FT_New_Face.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p)]
    library.FT_Get_Sfnt_Name_Count.argtypes = [ctypes.c_void_p]
    library.FT_Get_Sfnt_Name_Count.restype = ctypes.c_uint
    library.FT_Get_Sfnt_Name.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(FontName)]
    library.FT_Done_Face.argtypes = [ctypes.c_void_p]
    library.FT_Done_FreeType.argtypes = [ctypes.c_void_p]
    engine = ctypes.c_void_p()
    if library.FT_Init_FreeType(ctypes.byref(engine)):
        raise RuntimeError("Could not initialize FreeType.")
    result = []
    try:
        for directory in sorted(Path(root).iterdir()):
            if not directory.is_dir():
                continue
            files = sorted(filename for filename in directory.iterdir() if filename.suffix in (".woff", ".woff2", ".ttf", ".otf"))
            if not files:
                raise RuntimeError(f"No font files found for {directory.name}.")
            notices = set()
            hashes = {}
            for filename in files:
                hashes[filename.name] = hashlib.sha256(filename.read_bytes()).hexdigest()
                face = ctypes.c_void_p()
                error = library.FT_New_Face(engine, str(filename).encode(), 0, ctypes.byref(face))
                if error:
                    raise RuntimeError(f"FreeType could not inspect {filename.name}: {error}")
                try:
                    for index in range(library.FT_Get_Sfnt_Name_Count(face)):
                        name = FontName()
                        if library.FT_Get_Sfnt_Name(face, index, ctypes.byref(name)) or name.name_id not in (0, 13, 14):
                            continue
                        raw = ctypes.string_at(name.string, name.string_len)
                        encoding = "utf-16-be" if name.platform_id in (0, 3) else "mac_roman"
                        notices.add(raw.decode(encoding, errors="strict"))
                finally:
                    library.FT_Done_Face(face)
            if not notices:
                raise RuntimeError(f"No embedded copyright/license evidence for {directory.name}.")
            result.append({"name": directory.name, "files": hashes, "embeddedNotices": sorted(notices)})
    finally:
        library.FT_Done_FreeType(engine)
    return result


if __name__ == "__main__":
    print(json.dumps(collect_fonts(sys.argv[1]), ensure_ascii=True))