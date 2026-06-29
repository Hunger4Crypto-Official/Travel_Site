export function success(source, data, meta = {}) {
  return { status: 'success', source, data, meta };
}

export function error(message, statusCode = 500, details = {}) {
  return { status: 'error', error: { message, statusCode, details } };
}
