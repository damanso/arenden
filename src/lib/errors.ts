// Applikationsfel med HTTP-status. Kastas från tjänster/handlers och översätts
// till JSON i felmiddlewaren — aldrig stacktraces till klienten.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'resource') {
    super(404, 'not_found', `${what} not found`);
  }
}

export class UnauthenticatedError extends AppError {
  constructor() {
    super(401, 'unauthenticated');
  }
}

export class BadRequestError extends AppError {
  constructor(code = 'bad_request', message?: string) {
    super(400, code, message);
  }
}
