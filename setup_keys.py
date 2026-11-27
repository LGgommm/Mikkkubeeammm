import base64
import secrets
from pathlib import Path
from cryptography.hazmat.primitives import serialization as fmt
from cryptography.hazmat.primitives.asymmetric import ec

key = ec.generate_private_key(ec.SECP256R1())
pub = key.public_key().public_bytes(fmt.Encoding.X962,fmt.PublicFormat.UncompressedPoint)
path = Path("vapid.pem")
with path.open("xb") as f:
    path.chmod(0o600)
    f.write(key.private_bytes(fmt.Encoding.PEM,fmt.PrivateFormat.PKCS8,fmt.NoEncryption()))
print("ADMIN_KEY="+secrets.token_urlsafe(32))
print("VAPID_PUBLIC="+base64.urlsafe_b64encode(pub).decode().rstrip("="))
print("VAPID_PRIVATE="+str(path.resolve()))
