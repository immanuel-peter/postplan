async (page) => {
  if (!page._ppAuth) {
    throw new Error('no virtual authenticator on this page; run attach-authenticator.js first');
  }
  const { cdp, authenticatorId } = page._ppAuth;
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  return JSON.stringify(credentials);
}
