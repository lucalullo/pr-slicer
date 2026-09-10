export class SlicerError extends Error { constructor(message: string, public readonly code = 'INVALID_INPUT') { super(message); this.name = 'SlicerError'; } }
