"""Build a local UI-only font subset, preserving the OFL and renaming the derivative."""
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
import json

root = Path(__file__).resolve().parents[1]
source = root / 'art-source/fonts/ChillRoundF.ttf'
text = ''.join(chr(i) for i in range(32, 127))
for directory in [root / 'game', root / 'docs']:
    for item in directory.rglob('*'):
        if item.suffix in {'.html', '.js', '.md'}:
            text += item.read_text(encoding='utf-8')
font = TTFont(source)
options = subset.Options()
options.flavor = 'woff2'
options.name_IDs = ['*']
options.name_legacy = True
options.name_languages = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(text=text)
subsetter.subset(font)
rename = {1:'Siren Round UI', 2:'Regular', 3:'SirenRoundUI-1.0',
          4:'Siren Round UI', 6:'SirenRoundUI-Regular', 16:'Siren Round UI', 17:'Regular'}
for record in font['name'].names:
    if record.nameID in rename:
        record.string = rename[record.nameID].encode(record.getEncoding(), errors='replace')
font.flavor = 'woff2'
destination = root / 'game/assets/fonts/siren-round.woff2'
destination.parent.mkdir(parents=True, exist_ok=True)
font.save(destination)
(destination.parent / 'license.json').write_text(json.dumps({
    'source': 'https://github.com/Warren2060/ChillRound',
    'original': 'ChillRoundF v3.0',
    'derivative': 'Siren Round UI — character subset; glyph outlines unchanged',
    'license': (root / 'art-source/fonts/OFL.txt').read_text(encoding='utf-8')
}, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'{destination.name}: {destination.stat().st_size:,} bytes')
