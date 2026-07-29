exports.handler = async () => ({
  statusCode: 302,
  headers: {
    Location: '/?logged_out=1',
    'Set-Cookie': 'sfp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  },
  body: ''
});
