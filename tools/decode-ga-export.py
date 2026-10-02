#!/usr/bin/env python3
"""
Офлайн-декодер экспорта Google Authenticator.

Принимает QR «Перенос аккаунтов → Экспорт аккаунтов» (строка otpauth-migration://...
или картинка с этим QR) и печатает обычные otpauth://totp-ссылки с seed'ами.

Работает полностью локально: ни одного сетевого вызова в коде нет. Вывод содержит
секреты — не пересылать его никуда, в том числе в чат с ассистентом.

Примеры:
    python3 tools/decode-ga-export.py ~/Downloads/qr.png
    python3 tools/decode-ga-export.py 'otpauth-migration://offline?data=Ci0K...'
    python3 tools/decode-ga-export.py qr1.png qr2.png        # если экспорт разбит на несколько QR

На macOS картинки читаются штатной Vision (qr-decode.swift рядом) — ставить ничего не нужно,
но первый запуск занимает до минуты: swift компилирует скрипт. Если не сработало, помогут
    pip3 install pyzbar pillow && brew install zbar          (устойчивее к фото экрана)
    pip3 install opencv-python-headless
Строку otpauth-migration:// можно передать и вообще без декодера.
"""

import base64
import os
import shutil
import subprocess
import sys
import urllib.parse

ALGORITHMS = {0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512", 4: "MD5"}
DIGITS = {0: 6, 1: 6, 2: 8}
OTP_TYPES = {0: "totp", 1: "hotp", 2: "totp"}


def read_varint(buf, pos):
    result = shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("payload оборван на varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def parse_fields(buf):
    """Разбор protobuf-wire без зависимостей: отдаёт пары (номер поля, значение)."""
    pos = 0
    while pos < len(buf):
        tag, pos = read_varint(buf, pos)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            value, pos = read_varint(buf, pos)
        elif wire == 2:
            length, pos = read_varint(buf, pos)
            value, pos = buf[pos:pos + length], pos + length
        elif wire == 5:
            value, pos = buf[pos:pos + 4], pos + 4
        elif wire == 1:
            value, pos = buf[pos:pos + 8], pos + 8
        else:
            raise ValueError(f"неподдерживаемый wire type {wire}")
        yield field, value


def parse_otp_parameters(buf):
    """MigrationPayload.OtpParameters: 1 secret, 2 name, 3 issuer, 4 algo, 5 digits, 6 type, 7 counter."""
    acc = {"secret": b"", "name": "", "issuer": "", "algorithm": 1, "digits": 1, "type": 2, "counter": 0}
    for field, value in parse_fields(buf):
        if field == 1:
            acc["secret"] = value
        elif field == 2:
            acc["name"] = value.decode("utf-8", "replace")
        elif field == 3:
            acc["issuer"] = value.decode("utf-8", "replace")
        elif field in (4, 5, 6, 7):
            acc[{4: "algorithm", 5: "digits", 6: "type", 7: "counter"}[field]] = value
    return acc


def parse_migration_uri(uri):
    """otpauth-migration://offline?data=<base64 protobuf> → список аккаунтов."""
    uri = uri.strip().strip('"').strip("'")
    if not uri.lower().startswith("otpauth-migration://"):
        raise ValueError(f"это не otpauth-migration-ссылка: {uri[:40]}...")
    query = urllib.parse.urlparse(uri).query
    data = urllib.parse.parse_qs(query).get("data", [None])[0]
    if not data:
        raise ValueError("в ссылке нет параметра data")
    raw = base64.b64decode(data + "=" * (-len(data) % 4))

    accounts, meta = [], {}
    for field, value in parse_fields(raw):
        if field == 1:
            accounts.append(parse_otp_parameters(value))
        elif field in (2, 3, 4, 5):
            meta[{2: "version", 3: "batch_size", 4: "batch_index", 5: "batch_id"}[field]] = value
    return accounts, meta


def to_otpauth(acc):
    secret = base64.b32encode(acc["secret"]).decode("ascii").rstrip("=")
    kind = OTP_TYPES.get(acc["type"], "totp")
    label = acc["name"] or "account"
    params = {
        "secret": secret,
        "algorithm": ALGORITHMS.get(acc["algorithm"], "SHA1"),
        "digits": str(DIGITS.get(acc["digits"], 6)),
    }
    if acc["issuer"]:
        params["issuer"] = acc["issuer"]
    if kind == "totp":
        params["period"] = "30"
    else:
        params["counter"] = str(acc["counter"])
    return secret, "otpauth://{}/{}?{}".format(
        kind, urllib.parse.quote(label), urllib.parse.urlencode(params)
    )


def decode_qr_macos(path):
    """Штатная macOS Vision через qr-decode.swift — ничего ставить не нужно."""
    if sys.platform != "darwin":
        return []
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qr-decode.swift")
    swift = shutil.which("swift")
    if not swift or not os.path.exists(script):
        return []
    try:
        # Первый запуск может занять до минуты: swift компилирует скрипт на лету.
        result = subprocess.run([swift, script, path], capture_output=True, text=True, timeout=300)
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"  Vision не отработала: {exc}", file=sys.stderr)
        return []
    if result.returncode != 0:
        if result.stderr.strip():
            print(f"  Vision: {result.stderr.strip()}", file=sys.stderr)
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def decode_qr(path):
    """macOS Vision → pyzbar → OpenCV. Первый, кто справился, тот и прав."""
    if not os.path.exists(path):
        raise SystemExit(
            f"Нет такого файла: {path}\n"
            "Ожидаю путь к картинке с QR или строку otpauth-migration://..."
        )

    found = decode_qr_macos(path)
    if found:
        return found

    try:
        from pyzbar.pyzbar import decode as zbar_decode
        from PIL import Image
        found = [d.data.decode("utf-8", "replace") for d in zbar_decode(Image.open(path))]
        if found:
            return found
    except ImportError:
        pass
    except Exception as exc:
        print(f"  pyzbar не справился: {exc}", file=sys.stderr)

    try:
        import cv2
    except ImportError:
        raise SystemExit(
            "Не найден декодер QR. Поставь любой:\n"
            "    pip3 install pyzbar pillow && brew install zbar\n"
            "    pip3 install opencv-python-headless\n"
            "…либо передай строку otpauth-migration:// текстом."
        )
    image = cv2.imread(path)
    if image is None:
        raise SystemExit(f"Не читается картинка: {path}")
    ok, decoded, _, _ = cv2.QRCodeDetector().detectAndDecodeMulti(image)
    found = [d for d in decoded if d] if ok else []
    if not found:
        single, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
        found = [single] if single else []
    if not found:
        raise SystemExit(
            f"QR не распознан: {path}\n"
            "Попробуй скриншот вместо фото, кадр покрупнее и без бликов, "
            "или поставь pyzbar — он устойчивее."
        )
    return found


def main(argv):
    if not argv:
        print(__doc__)
        return 1

    uris = []
    for arg in argv:
        if arg.lower().startswith("otpauth-migration://"):
            uris.append(arg)
        else:
            uris.extend(decode_qr(arg))

    total, batch_size = 0, 1
    for uri in uris:
        try:
            accounts, meta = parse_migration_uri(uri)
        except Exception as exc:
            raise SystemExit(f"Не разобрал ссылку: {exc}")
        batch_size = max(batch_size, meta.get("batch_size", 1))
        if meta.get("batch_size", 1) > 1:
            print(f"\n# часть {meta.get('batch_index', 0) + 1} из {meta['batch_size']}")
        for acc in accounts:
            secret, link = to_otpauth(acc)
            total += 1
            title = f"{acc['issuer']} / {acc['name']}" if acc["issuer"] else acc["name"]
            print(f"\n=== {title} ===")
            print(f"seed (base32): {secret}")
            print(f"otpauth:       {link}")

    print(f"\nВсего аккаунтов: {total}")
    if batch_size > len(uris):
        print(f"Экспорт разбит на {batch_size} QR, а передано {len(uris)} — "
              "остальные части обработай тем же вызовом, перечислив все картинки.")
    print("Секреты выше — не пересылай их никуда, в том числе в чат с ассистентом.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
