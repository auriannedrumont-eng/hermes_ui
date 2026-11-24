"""Inventaire PRÉCIS des variables libres du grand effet (406-869) — sans bruit de littéraux."""
import re
from pathlib import Path

F = Path("/home/z/my-project/repos/hermes_ui/src/hooks/use-hermes-chat.ts")
lines = F.read_text(encoding="utf-8").splitlines()

START, DEP = 406, 869  # 1-based
body_lines = lines[START - 1 : DEP - 1]
dep_line = lines[DEP - 1].strip()

def strip_noise(text: str) -> str:
    text = re.sub(r"//[^\n]*", "", text)          # commentaires ligne
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)  # blocs
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)    # chaînes ""
    text = re.sub(r"'(?:[^'\\]|\\.)*'", "''", text)    # chaînes ''
    text = re.sub(r"`(?:[^`\\]|\\.)*`", "``", text)    # template literals
    return text

body = strip_noise("\n".join(body_lines))

# ── déclarés dans le span ──
span_declared = set(re.findall(r"\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)", body))

# ── déclarés dans le hook (hors span) : const x = ... ET destructuring const { a, b } = ... ──
hook_declared = {}
for i, ln in enumerate(lines, 1):
    if START <= i < DEP:
        continue
    clean = strip_noise(ln)
    for m in re.finditer(r"\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=", clean):
        hook_declared.setdefault(m.group(1), (i, ln.strip()))
    for m in re.finditer(r"\bconst\s*\{([^}]*)\}\s*=", clean):
        for name in m.group(1).split(","):
            name = name.strip().split(":")[-1].split("=")[0].strip()
            if name:
                hook_declared.setdefault(name, (i, ln.strip()))

# ── imports du module ──
imports = set()
for ln in lines[:60]:
    for grp in re.findall(r"import\s+(?:type\s+)?\{([^}]*)\}", ln):
        for name in grp.split(","):
            name = name.strip().replace("type ", "").strip()
            if name:
                imports.add(name.split(" as ")[-1].strip())
    for m in re.findall(r"import\s+([A-Za-z_$][\w$]*)\s+from", ln):
        imports.add(m)

globals_ok = {
    "clearTimeout", "setTimeout", "window", "document", "console", "Object", "JSON",
    "Math", "Date", "Number", "String", "Boolean", "Array", "Promise", "Error", "isNaN",
    "Set", "Map", "Intl", "requestAnimationFrame", "cancelAnimationFrame", "URL", "Blob",
    "File", "location", "navigator", "localStorage", "fetch", "parseInt",
}
react_apis = {"useEffect", "useState", "useRef", "useCallback", "useMemo", "React"}

used = set(re.findall(r"\b[A-Za-z_$][\w$]*\b", body))
free = sorted(
    u for u in used
    if u not in span_declared and u not in hook_declared and u not in imports
    and u not in globals_ok and u not in react_apis and not u[0].isupper()
)
print(f"déps du useEffect : {dep_line}")
print(f"\nvariables libres RÉELLES ({len(free)}) :")
for name in free:
    src = hook_declared.get(name)
    print(f"  {name:34s} L{src[0] if src else '?'}: {(src[1] if src else '')[:95]}")
