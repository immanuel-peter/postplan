async (page) => {
  if (page._ppAuth) {
    return { authenticatorId: page._ppAuth.authenticatorId, reused: true };
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  page._ppAuth = { cdp, authenticatorId };
  return { authenticatorId, reused: false };
}
