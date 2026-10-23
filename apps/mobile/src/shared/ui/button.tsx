import { TextClassContext } from "@/shared/ui/text";
import { cn } from "@/shared/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { Platform, Pressable } from "react-native";

const buttonVariants = cva(
  cn(
    "group shrink-0 flex-row items-center justify-center gap-2 rounded-control shadow-none",
    Platform.select({
      web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    }),
  ),
  {
    variants: {
      variant: {
        default: cn(
          "bg-primary active:bg-primary-hover",
          Platform.select({ web: "hover:bg-primary-hover" }),
        ),
        destructive: cn(
          "border border-destructive/30 bg-destructive/10 active:bg-destructive/20",
          Platform.select({
            web: "hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
          }),
        ),
        outline: cn(
          "border-input bg-secondary active:bg-accent border",
          Platform.select({
            web: "hover:bg-accent dark:hover:bg-input/50",
          }),
        ),
        secondary: cn(
          "bg-secondary active:bg-secondary/80",
          Platform.select({ web: "hover:bg-secondary/80" }),
        ),
        ghost: cn(
          "active:bg-accent dark:active:bg-accent/50",
          Platform.select({ web: "hover:bg-accent dark:hover:bg-accent/50" }),
        ),
        link: "",
      },
      size: {
        default: cn(
          "min-h-12 px-5 py-3",
          Platform.select({ web: "has-[>svg]:px-3" }),
        ),
        sm: cn(
          "min-h-11 gap-1.5 px-4 py-2",
          Platform.select({ web: "has-[>svg]:px-2.5" }),
        ),
        lg: cn(
          "min-h-12 px-6 py-3",
          Platform.select({ web: "has-[>svg]:px-4" }),
        ),
        icon: "h-12 w-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const buttonTextVariants = cva(
  cn(
    "shrink text-center text-foreground text-[15px] font-semibold",
    Platform.select({ web: "pointer-events-none transition-colors" }),
  ),
  {
    variants: {
      variant: {
        default: "text-primary-foreground",
        destructive: "text-destructive",
        outline: cn(
          "group-active:text-accent-foreground",
          Platform.select({ web: "group-hover:text-accent-foreground" }),
        ),
        secondary: "text-secondary-foreground",
        ghost: "text-muted-foreground group-active:text-accent-foreground",
        link: cn(
          "text-primary group-active:underline",
          Platform.select({
            web: "underline-offset-4 hover:underline group-hover:underline",
          }),
        ),
      },
      size: {
        default: "",
        sm: "",
        lg: "",
        icon: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(
          props.disabled && "opacity-50",
          buttonVariants({ variant, size }),
          className,
        )}
        role="button"
        accessibilityState={{
          disabled: props.disabled,
          ...props.accessibilityState,
        }}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
