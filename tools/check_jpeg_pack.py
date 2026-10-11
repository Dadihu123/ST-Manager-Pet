"""手工核对：包内 JPEG 是否被真正转成 PNG，且 manifest 的 sheet 指向被同步改掉。

这个脚本不在 pytest 里跑，用于人工确认「JPEG 兼容」这条链是通的
（pytest 里已有单测，这里是可打印的现场证据）。
"""

import io
import json
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

from backend.core.store import PetStore  # noqa: E402


def main():
    tmp = tempfile.mkdtemp(prefix='pet-jpeg-check-')
    data = os.path.join(tmp, 'data')
    builtin = os.path.join(tmp, 'resources', 'pets')
    os.makedirs(data)
    os.makedirs(builtin)
    store = PetStore(data, builtin)

    buffer = io.BytesIO()
    Image.new('RGB', (64, 64), (200, 10, 10)).save(buffer, format='JPEG')
    manifest = json.dumps({
        'id': 'jp',
        'animations': {'idle': {'sheet': 'idle.jpg', 'frames': 1}},
    }).encode('utf-8')

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as handle:
        handle.writestr('pet.json', manifest)
        handle.writestr('idle.jpg', buffer.getvalue())

    result = store.import_zip(archive.getvalue())

    print('pack id        :', result['id'])
    print('idle entry     :', json.dumps(result['actions']['idle'], ensure_ascii=False))
    directory = store.user_pet_dir('jp')
    print('files on disk  :', sorted(os.listdir(directory)))

    with open(os.path.join(directory, 'pet.json'), encoding='utf-8') as handle:
        stored = json.load(handle)
    print('manifest anim  :', json.dumps(stored['animations'], ensure_ascii=False))

    path, source = store.resolve_frame_path('jp', 'idle')
    with open(path, 'rb') as handle:
        head = handle.read(8)
    print('resolved path  :', os.path.basename(path), '| source:', source)
    print('magic bytes    :', head[:4], '→', 'PNG' if head.startswith(b'\x89PNG') else 'NOT PNG')


if __name__ == '__main__':
    main()
