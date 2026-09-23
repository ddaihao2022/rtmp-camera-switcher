import json
import base64
import hashlib
from Crypto.Cipher import AES

# ---------- 工具函数 ----------
def b64url_decode(s: str) -> bytes:
    s = s.replace('-', '+').replace('_', '/')
    padding = 4 - len(s) % 4
    if padding != 4:
        s += '=' * padding
    return base64.b64decode(s)

def b64url_encode(data: bytes) -> str:
    return base64.b64encode(data).decode('utf-8').replace('+', '-').replace('/', '_').rstrip('=')

def decrypt(encrypted: dict):
    key = hashlib.sha256(b"xg-2026-mj-api-seal").digest()
    iv = b64url_decode(encrypted['i'])
    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    # 注意：密文末尾 16 字节是 GCM Tag
    ciphertext = b64url_decode(encrypted['d'])
    # AES-GCM 解密需要分别处理 data 和 tag
    data = ciphertext[:-16]
    tag = ciphertext[-16:]
    plain = cipher.decrypt_and_verify(data, tag)
    return json.loads(plain.decode('utf-8'))

def encrypt(plain: dict) -> dict:
    key = hashlib.sha256(b"xg-2026-mj-api-seal").digest()
    iv = b64url_decode("v_hi6oDoQKYtYgO_")  # 可以重新生成随机 IV，这里复用原 IV 方便演示
    # 实际测试建议生成随机 IV：iv = AES.get_random_bytes(12)
    data = json.dumps(plain, separators=(',', ':')).encode('utf-8')
    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    ciphertext, tag = cipher.encrypt_and_digest(data)
    return {
        "xgEnc": 1,
        "i": b64url_encode(iv),
        "d": b64url_encode(ciphertext + tag)
    }

# ---------- 1. 解密原始请求 ----------
raw = {
  "xgEnc": 1,
  "i": "v_hi6oDoQKYtYgO_",
  "d": "gZBFF2dKHbyAZ-QU5BpIWhEYi4-j8UDBTDs0uJZqUj9cIY7z4U3N1UKLFiYgSwfaopRPbD9W2arFoZjwVa4sB6OnY2CBeWPaJTUTbYVy299kkjsp9DpWzaGGtdUI3QyO6soV08eJEju64zHzLdqqAIVAmcJsjdcNs5FTglUPrMrFXC88peaMPuML7861y5GF6jBIN4F3D2yAPCly0A62dxAJSr6Mny9AWZ_ZMk8ydmt_tzWksPDr-Tnsd_cFD0n1EMEgko21UPa-vsVbmcyZUq_dAYVWxh7NtWMMQ-POjGOBSupt808Rwed14m56UzQe-GOzKna2MutChmfiBVd2BaFJ-cbW52wUG2worsUq2Q6OyONiozk12D2yxg8NdELc4SbUrGS2KzIOBIB8YC2netVMf7PdTLmC52XSP3mPTvxhBu2UlRzjATbPH4z9E5nlm2FuqfqqjS_b1NOWd2RaGIcoEQ04HzFwkumSY_GRsr9at5P3tZW28D83ci8igZlxj51RvKxVIK7TnzWRKnSLeKD70nKVHgm5maBLlNoGL5FzeHG2FNW4bJWE_COQsHkXFxuNC3UGyY96m-rbhkqyQ7k5bvaYWHTwOdQ8b_jikmeI4YW0lgFF4pDxbbJfjcHGFhp6f_23UpoGDJvvJ7YbqNPthjsB6MeTgaGU9EvH4CTAgGrfZ7RwSjho_g3ZRhq4HOeEAEqXPLaHkX-Q6u5FIlFeLcg_Y6kQX8ezDBPlgUr-kRS99PqlRsYi25VPbB9aEXJVfVZQ43csgyDBzciPRKKGfsq29EVETlvFEr_TcZmUllUuiQZSz2-_5nfCDjQBbpq8unibgy8B7CKOK925iXNuZnz29Gm4ropQO2s9rxqQWBbh3eNqkZL4qC5O-N2NudyUxeLABzT4yv6kVrntPDYR8fgQVUC7n5xGIDLUFowqdLZKfnzjaBBSKWdDkdVbverHckgEF_Fa"
}

original_plain = decrypt(raw)
print("原始明文:")
print(json.dumps(original_plain, indent=2, ensure_ascii=False))

# ---------- 2. 篡改数据 ----------
modified_plain = original_plain.copy()

# 测试场景 A：把第一个物品改成更值钱的，并额外增加一个物品
modified_plain['loot'][0]['name'] = "玉覆面"
modified_plain['loot'][0]['value'] = 1180000
modified_plain['loot'][0]['hint'] = "传说 · 估值 1180000 铜钱"
modified_plain['loot'][0]['color'] = 14988359  # 传说金色

# 增加一个新物品
new_item = {
    "id": "test-999-1785124919360",
    "name": "测试龙脉金珠",
    "hint": "测试添加的物品",
    "identified": True,
    "size": 2,
    "color": 16777215,
    "value": 999999,
    "taken": True
}
modified_plain['loot'].append(new_item)

print("\n修改后的明文:")
print(json.dumps(modified_plain, indent=2, ensure_ascii=False))

# ---------- 3. 重新加密 ----------
new_encrypted = encrypt(modified_plain)
print("\n重新加密后的请求体 (可直接替换原请求体):")
print(json.dumps(new_encrypted, indent=2))

# ---------- 4. 发送请求 (可选) ----------
# 如果你想实际发送，取消注释下面代码，并填写你的 Cookie/Token
# import requests
# headers = {
#     "Content-Type": "application/json",
#     "Authorization": "Bearer eyJpZCI6...",  # 替换为你的真实 Token
#     "Cookie": "server_session_94aaeb1e=...", # 替换为你的真实 Cookie
#     "X-XG-Encrypted": "1"
# }
# resp = requests.post("https://mj.tqnb.online/api/me/extract", json=new_encrypted, headers=headers)
# print("\n服务端响应:")
# print(resp.status_code, resp.text)