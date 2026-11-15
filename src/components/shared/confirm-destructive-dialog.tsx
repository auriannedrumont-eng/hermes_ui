"use client";

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

type ConfirmDestructiveDialogProps = {
  /** Mode non contrôlé : l'élément déclencheur (bouton, item de menu) rendu tel quel. */
  trigger?: ReactNode;
  /** Mode contrôlé (ex. depuis un DropdownMenuItem : on ferme le menu, on ouvre la garde). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

/* La garde unique des actions destructives (passe 2 C5.1/C2.2) : toute action
   qui détruit du contenu — conversation, message, mémoire, lien public,
   projet — passe par ce dialogue. Une seule façon de confirmer : libellé
   explicite, bouton confirmé en destructive, jamais window.confirm natif. */
export function ConfirmDestructiveDialog({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Supprimer",
  cancelLabel = "Annuler",
  onConfirm,
}: ConfirmDestructiveDialogProps) {
  const rootProps = trigger ? {} : { open, onOpenChange };
  return (
    <AlertDialog {...rootProps}>
      {trigger ? (
        <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      ) : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(
              "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60"
            )}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
