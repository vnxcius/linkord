// shadcn-style Button (solid-ui flavour): Kobalte's accessible button, variants with cva, Tailwind classes from
// the Graphite tokens in styles.css.
import { Button as KButton } from '@kobalte/core/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { splitProps, type ComponentProps } from 'solid-js';
import { cn } from '../../lib/cn';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-[var(--brand-hi)]',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-[var(--bg-4)]',
        ghost: 'text-text-2 hover:bg-accent hover:text-foreground',
        destructive: 'bg-destructive text-white hover:brightness-110',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-[13px]',
        lg: 'h-10 px-5',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['class', 'variant', 'size']);
  return <KButton class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)} {...rest} />;
}
