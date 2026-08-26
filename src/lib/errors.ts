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

/**
 * K-1: nekat p.g.a. ursprung (CSRF) eller saknad rattighet. Egen klass sa att
 * skrivrutterna i vyn kan skilja "du ar inte inloggad" (401) fran "det har
 * anropet kom inte fran vyn" (403) — tva helt olika saker for den som lasar.
 */
export class ForbiddenError extends AppError {
  constructor(code = 'forbidden', message?: string) {
    super(403, code, message);
  }
}

export class BadRequestError extends AppError {
  constructor(code = 'bad_request', message?: string) {
    super(400, code, message);
  }
}
