#!/usr/bin/env python3
"""
Печатает текущий 6-значный код из seed — то же самое, что показывает телефон.

Полностью офлайн: ни одного сетевого вызова. Seed спрашивается без эха, поэтому
не попадает ни в историю шелла, ни в список аргументов процесса (`ps`).

    python3 tools/totp.py              # спросит seed, напечатает код один раз
    python3 tools/totp.py --watch      # обновляет каждую секунду, выход — Ctrl+C

Принимает и голый base32 (`JBSWY3DP...`, пробелы и регистр не важны),
и целиком ссылку `otpauth://totp/...?secret=...`.

Нужен, чтобы сверить seed с приложением и чтобы было чем проверить расширение,
если оно вдруг начнёт получать отказ от биржи.
"""

import base64
import getpass
import hashlib
import hmac
import struct
import sys
import time
import urllib.parse

HASHES = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512, "MD5": hashlib.md5}


def parse_secret(raw):
    """Та же логика, что в parseTotpSecret() расширения."""
    text = (raw or "").strip().strip('"').strip("'")
    if not text:
        raise ValueError("seed не задан")
    if text.lower().startswith("otpauth://"):
        url = urllib.parse.urlparse(text)
        params = urllib.parse.parse_qs(url.query)
        secret = params.get("secret", [None])[0]
        if not secret:
            raise ValueError("в otpauth-ссылке нет secret")
        return {
            "secret": secret,
            "digits": int(params.get("digits", [6])[0]),
            "period": int(params.get("period", [30])[0]),
            "algorithm": params.get("algorithm", ["SHA1"])[0].upper(),
        }
    return {"secret": text, "digits": 6, "period": 30, "algorithm": "SHA1"}


def b32decode(secret):
    clean = secret.upper().replace(" ", "").replace("-", "").rstrip("=")
    if not clean:
        raise ValueError("пустой seed")
    bad = set(clean) - set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    if bad:
        raise ValueError(f"недопустимые символы в seed: {''.join(sorted(bad))}")
    return base64.b32decode(clean + "=" * (-len(clean) % 8))


def totp(cfg, at=None):
    """RFC 6238: HMAC от номера окна, динамическая обрезка до N цифр."""
    digest = HASHES.get(cfg["algorithm"], hashlib.sha1)
    counter = int((at if at is not None else time.time()) // cfg["period"])
    mac = hmac.new(b32decode(cfg["secret"]), struct.pack(">Q", counter), digest).digest()
    offset = mac[-1] & 0x0F
    code = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % 10 ** cfg["digits"]).zfill(cfg["digits"])


def seconds_left(period, at=None):
    return period - int(at if at is not None else time.time()) % period


def self_test():
    """Тестовые векторы RFC 6238: ASCII '12345678901234567890', SHA-1."""
    cfg = parse_secret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    expected = [(59, "287082"), (1111111109, "081804"), (1234567890, "005924"),
                (2000000000, "279037"), (20000000000, "353130")]
    bad = 0
    for at, want in expected:
        got = totp(cfg, at)
        ok = got == want
        bad += not ok
        print(f"t={at:<12} ожидаем {want}  получили {got}  {'OK' if ok else 'ПРОВАЛ'}")
    print("self-test:", "всё сходится" if not bad else f"провалов {bad}")
    return 1 if bad else 0


def main(argv):
    if "--self-test" in argv:
        return self_test()

    if sys.stdin.isatty():
        raw = getpass.getpass("seed (ввод скрыт): ")
    else:
        raw = sys.stdin.readline()

    try:
        cfg = parse_secret(raw)
        b32decode(cfg["secret"])          # ранняя проверка, пока не начали цикл
    except ValueError as exc:
        print(f"Не разобрал seed: {exc}", file=sys.stderr)
        return 2

    if "--watch" not in argv:
        print(f"{totp(cfg)}   (осталось {seconds_left(cfg['period'])} с)")
        return 0

    print("Сверяй с телефоном. Выход — Ctrl+C.")
    try:
        while True:
            left = seconds_left(cfg["period"])
            bar = "#" * left + "." * (cfg["period"] - left)
            print(f"\r{totp(cfg)}  {left:>2} с  [{bar}]", end="", flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
