"""Inventaire final : variables libres du grand effet, avec déclarations exactes."""
import re
from pathlib import Path

F = Path("/home/z/my-project/repos/hermes_ui/src/hooks/use-hermes-chat.ts")
raw = F.read_text(encoding="utf-8")
lines = raw.splitlines()

def strip_noise(text: str) -> str:
    text = re.sub(r"//[^\n]*", " ", text)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
    text = re.sub(r"'(?:[^'\\]|\\.)*'", "''", text)
    text = re.sub(r"`(?:[^`\\]|\\.)*`", "``", text)
    return text

clean = strip_noise(raw)
# map offset → numéro de ligne
line_starts = [0]
for ln in lines:
    line_starts.append(line_starts[-1] + len(ln) + 1)
def line_of(offset: int) -> int:
    lo, hi = 0, len(line_starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if line_starts[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1

START, DEP = 406, 869
span_clean = strip_noise("\n".join(lines[START - 1 : DEP - 1]))
span_declared = set(re.findall(r"\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)", span_clean))
# destructuring de paramètres d'arrows dans le span : ({ a, b }) => et (m) =>
span_declared |= set(re.findall(r"\(\s*\{([^}]*)\}\s*\)", span_clean))  # trop large, affiné ci-dessous
span_params = set()
for grp in re.findall(r"\(\s*\{([^}]*)\}\s*(?:\)|:)", span_clean):
    for name in grp.split(","):
        name = name.strip().split(":")[0].split("=")[0].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
            span_params.add(name)
# simples paramètres (m, c, p...)
for grp in re.findall(r"\((\s*[A-Za-z_$][\w$]*)\s*(?:\)|,|:)", span_clean):
    span_params.add(grp.strip())

hook_declared: dict[str, tuple[int, str]] = {}
for m in re.finditer(r"\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=", clean):
    hook_declared.setdefault(m.group(1), (line_of(m.start()), lines[line_of(m.start()) - 1].strip()))
for m in re.finditer(r"\bconst\s*\{([^{}]*)\}\s*=", clean, flags=re.S):
    for name in m.group(1).split(","):
        name = name.strip().split(":")[-1].split("=")[0].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
            hook_declared.setdefault(name, (line_of(m.start()), lines[line_of(m.start()) - 1].strip()))
for m in re.finditer(r"\bconst\s*\[([^\[\]]*)\]\s*=", clean, flags=re.S):
    for name in m.group(1).split(","):
        name = name.strip().split(":")[-1].split("=")[0].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
            hook_declared.setdefault(name, (line_of(m.start()), lines[line_of(m.start()) - 1].strip()))

imports = set()
for m in re.finditer(r"import\s+(?:type\s+)?\{([^}]*)\}", clean):
    for name in m.group(1).split(","):
        name = name.strip().replace("type ", "").strip()
        if name:
            imports.add(name.split(" as ")[-1].strip())
for m in re.finditer(r"import\s+([A-Za-z_$][\w$]*)\s+from", clean):
    imports.add(m.group(1))

KEYWORDS = {
    "as", "if", "else", "in", "of", "new", "delete", "typeof", "return", "const", "let",
    "var", "function", "true", "false", "null", "undefined", "void", "for", "while",
    "break", "continue", "case", "switch", "default", "throw", "try", "catch", "finally",
    "async", "await", "yield", "class", "extends", "super", "this", "do", "instanceof",
}
GLOBALS = {
    "clearTimeout", "setTimeout", "window", "document", "console", "Object", "JSON",
    "Math", "Date", "Number", "String", "Boolean", "Array", "Promise", "Error", "isNaN",
    "Set", "Map", "Intl", "requestAnimationFrame", "cancelAnimationFrame", "URL", "Blob",
    "File", "location", "navigator", "localStorage", "fetch", "parseInt", "isFinite",
    "parseFloat", "RegExp", "Error", "AbortSignal",
}
REACT = {"useEffect", "useState", "useRef", "useCallback", "useMemo", "React", "JSX"}

used = set(re.findall(r"\b[A-Za-z_$][\w$]*\b", span_clean))
free = sorted(
    u for u in used
    if u not in span_declared and u not in span_params and u not in hook_declared
    and u not in imports and u not in GLOBALS and u not in REACT and u not in KEYWORDS
    and not u[0].isupper()
)
print(f"déps effect : {lines[DEP-1].strip()}")
print(f"variables libres restantes ({len(free)}) :")
for name in free:
    src = hook_declared.get(name)
    print(f"  {name:30s} L{src[0] if src else '?'}: {(src[1] if src else '')[:100]}")
