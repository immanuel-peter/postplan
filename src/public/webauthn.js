function pkDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function pkEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = "";
  for (let i = 0; i < bytes.length; i += 1) {
    raw += String.fromCharCode(bytes[i]);
  }
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(pkMessage(detail.error));
  }
  return response.json();
}

function pkMessage(code) {
  switch (code) {
    case "challenge expired":
      return "That took too long. Try again.";
    case "too many attempts":
      return "Too many attempts. Wait a few minutes and try again.";
    case "no passkey enrolled":
      return "No passkey is enrolled on this deployment yet.";
    case "setup already completed":
      return "Setup was already completed from another browser.";
    case "recovery secret already used":
      return "That recovery secret has already been used. Rotate it and try again.";
    default:
      return "That passkey wasn’t verified. Try again.";
  }
}

async function postplanUnlock(next) {
  const options = await pkPost("/auth/login/options", {});
  options.challenge = pkDecode(options.challenge);
  if (options.allowCredentials) {
    options.allowCredentials = options.allowCredentials.map((item) => ({
      ...item,
      id: pkDecode(item.id),
    }));
  }
  const credential = await navigator.credentials.get({ publicKey: options });
  await pkPost("/auth/login/verify", {
    id: credential.id,
    rawId: pkEncode(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: pkEncode(credential.response.clientDataJSON),
      authenticatorData: pkEncode(credential.response.authenticatorData),
      signature: pkEncode(credential.response.signature),
      userHandle: credential.response.userHandle ? pkEncode(credential.response.userHandle) : undefined,
    },
  });
  window.location.assign(next || "/");
}

async function postplanEnroll(options, name, csrf) {
  const publicKey = { ...options };
  publicKey.challenge = pkDecode(publicKey.challenge);
  publicKey.user = { ...publicKey.user, id: pkDecode(publicKey.user.id) };
  if (publicKey.excludeCredentials) {
    publicKey.excludeCredentials = publicKey.excludeCredentials.map((item) => ({
      ...item,
      id: pkDecode(item.id),
    }));
  }
  const credential = await navigator.credentials.create({ publicKey });
  const transports = credential.response.getTransports ? credential.response.getTransports() : [];
  await pkPost("/auth/register/verify", {
    name,
    _csrf: csrf ?? undefined,
    credential: {
      id: credential.id,
      rawId: pkEncode(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: pkEncode(credential.response.clientDataJSON),
        attestationObject: pkEncode(credential.response.attestationObject),
        transports,
      },
    },
  });
  window.location.assign(csrf ? "/security" : "/");
}
