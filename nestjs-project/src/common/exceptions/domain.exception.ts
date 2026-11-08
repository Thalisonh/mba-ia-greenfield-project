export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotUploadableException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_UPLOADABLE',
      409,
      'Upload operations are only allowed while the video is a draft',
    );
  }
}

export class VideoFileTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_FILE_TOO_LARGE',
      400,
      'Video file exceeds the maximum allowed size',
    );
  }
}

export class InvalidPartRangeException extends DomainException {
  constructor() {
    super('INVALID_PART_RANGE', 400, 'Invalid upload part range');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      400,
      'The list of uploaded parts is incomplete or was rejected by the storage',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}

export class RangeNotSatisfiableException extends DomainException {
  constructor(size: number) {
    super('RANGE_NOT_SATISFIABLE', 416, 'Requested range is not satisfiable', {
      'Content-Range': `bytes */${size}`,
    });
  }
}
