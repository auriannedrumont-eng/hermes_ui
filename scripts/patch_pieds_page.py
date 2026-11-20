"""Post-traitement du docx : pagination compatible MS Office / WPS.
- retire les <w:pgNumType/> vides (section couverture)
- ajoute le commutateur de format au champ PAGE du pied de page (arabe)
"""
import re
import shutil
import sys
import zipfile

path = sys.argv[1]
tmp = path + ".tmp"

with zipfile.ZipFile(path, "r") as zin:
    items = zin.infolist()
    data = {i.filename: zin.read(i.filename) for i in items}

changed = []
for name in list(data):
    if name == "word/document.xml":
        xml = data[name].decode("utf-8")
        new = xml.replace("<w:pgNumType/>", "")
        if new != xml:
            data[name] = new.encode("utf-8")
            changed.append("document.xml: pgNumType vides retirés")
    elif re.match(r"word/footer\d*\.xml", name):
        xml = data[name].decode("utf-8")
        new = re.sub(
            r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
            r"\1 PAGE \\* arabic \\* MERGEFORMAT \2",
            xml,
        )
        if new != xml:
            data[name] = new.encode("utf-8")
            changed.append(f"{name}: PAGE -> arabic")

with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for i in items:
        zout.writestr(i, data[i.filename])
shutil.move(tmp, path)

print("\n".join(changed) if changed else "aucune modification nécessaire")
