import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class helper: conditional classes, with later Tailwind utilities winning over earlier ones. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
