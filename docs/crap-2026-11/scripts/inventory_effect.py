"""Inventaire des variables libres du grand useEffect de use-hermes-chat.ts (406-1049)."""
import re
from pathlib import Path

F = Path("/home/z/my-project/repos/hermes_ui/src/hooks/use-hermes-chat.ts")
lines = F.read_text(encoding="utf-8").splitlines()

# bornes : effet 406 → chercher la fin (}, [ ... ]); à partir de 406
end = None
depth = 0
for i in range(405, len(lines)):
    depth += lines[i].count("(") - lines[i].count(")")
    if re.match(r"^  \}, \[", lines[i]) and depth <= 0:
        end = i + 1  # 1-based
        break
print(f"effet : lignes 406-{end}")
dep_line = lines[end - 1].strip()
print(f"déps   : {dep_line}")

span = lines[405 : end - 1]
body = "\n".join(span)

# identifiants déclarés DANS le span (const/let/function/paramètres d'arrow connus)
declared = set(re.findall(r"\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)", body))
# handlers nommés dans le corps (const onXxx = ...)
locals_res = re.findall(r"\bconst\s+(on[A-Z][A-Za-z]*)\s*=", body)
declared |= set(locals_res)

globals_ok = {
    "clearTimeout", "setTimeout", "window", "document", "console", "Object", "JSON",
    "Math", "Date", "Number", "String", "Boolean", "Array", "Promise", "Error",
    "parseInt", "parseFloat", "isNaN", "isFinite", "undefined", "null", "true", "false",
    "fetch", "Set", "Map", "Intl", "requestAnimationFrame", "cancelAnimationFrame",
    "AbortController", "FileReader", "URL", "Blob", "File", "crypto", "location",
    "navigator", "localStorage", "sessionStorage", "history", "HTMLElement", "Element",
    "getComputedStyle", "matchMedia", "crypto", "TextEncoder", "alert", "confirm",
}

# imports connus du fichier (module scope) — extraits du fichier lui-même
imports = set()
for line in lines[:40]:
    m = re.findall(r"import\s+(?:type\s+)?\{([^}]*)\}", line)
    for grp in m:
        for name in grp.split(","):
            name = name.strip().replace("type ", "").strip()
            if name:
                imports.add(name.split(" as ")[-1].strip())
default_imports = re.findall(r'import\s+([A-Za-z_$][\w$]*)\s+from', "\n".join(lines[:40]))
imports |= set(default_imports)

# usage des identifiants camelCase dans le corps
used = set(re.findall(r"\b[A-Za-z_$][\w$]*\b", body))
hooks_builtins = {"useEffect", "useState", "useRef", "useCallback", "useMemo", "React"}

free = sorted(
    u for u in used
    if u not in declared and u not in globals_ok and u not in imports
    and u not in hooks_builtins and not u[0].isupper()
)
print(f"\nvariables libres ({len(free)}) :")
print(", ".join(free))

# types des déclarations du hook (pour l'interface de deps)
print("\ndéclarations correspondantes dans le hook :")
for name in free:
    for ln in lines:
        m = re.search(rf"\b(?:const|let)\s+{re.escape(name)}\b.*", ln)
        if m and "useChatSocketEvents" not in m.group(0):
            print(f"  {m.group(0).strip()[:110]}")
            break
Path("/tmp/effect-span.ts").write_text(body, encoding="utf-8")
print(f"\ncorps écrit dans /tmp/effect-span.ts ({end - 407} lignes)")
