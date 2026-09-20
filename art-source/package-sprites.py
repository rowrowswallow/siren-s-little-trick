from PIL import Image
from pathlib import Path
import shutil
root=Path(r"C:/Users/aisd/.codex/.chatgpt-projects/g-p-6aae938c179c819191403e23a20e3521/siren-s-little-trick")
source=Path(r"C:/Users/aisd/.codex/generated_images/01a0bb66-462f-7292-945f-8463fd6e6a20")
art=root/"art-source"/"generated"
art.mkdir(parents=True,exist_ok=True)
items=[
("exec-c6098db6-8e1e-4993-9a38-4ad8562f66c3.png","siren-atlas","characters",False),
("exec-2bf3641d-bb17-4431-bd3a-ec6df672d1c8.png","siren-mask","characters",True),
("exec-be513d51-e98d-4af4-819d-b85a381e13fa.png","boats-atlas","boats",False),
("exec-de33f856-08ce-4152-a9c6-c117ad55ee69.png","boats-mask","boats",True),
]
for original, name, folder, mask in items:
    shutil.copyfile(source/original, art/(name+".png"))
    target=root/"game"/"assets"/folder/(name+".webp")
    target.parent.mkdir(parents=True,exist_ok=True)
    im=Image.open(source/original)
    im.save(target,"WEBP",quality=90,method=6,lossless=mask)
    print(name,im.size,im.mode,target.stat().st_size,str(target))

