import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export const MIN_PASSWORD_LENGTH = 8;

export const hashPassword = async (plainPassword) => bcrypt.hash(plainPassword, SALT_ROUNDS);

export const comparePassword = async (plainPassword, hashedPassword) =>
  bcrypt.compare(plainPassword, hashedPassword);
