import type { CSSProperties } from "react";

export function currentRole(role?: string | null): string {
  return role?.trim() || "não definido";
}

// Papéis são livres e definidos pelo gerente. A cor é derivada do próprio
// texto, então novos papéis ganham apresentação estável sem entrar num catálogo.
export function roleColor(role?: string | null): string {
  const value = currentRole(role).toLocaleLowerCase();
  if (value === "não definido") return "var(--text-muted)";

  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 38% 72%)`;
}

export function roleIconStyle(role?: string | null): CSSProperties {
  return { color: roleColor(role) };
}

export function roleBadgeStyle(role?: string | null): CSSProperties {
  return { backgroundColor: roleColor(role), color: "#0f0e0b" };
}

export function roleTitle(role?: string | null): string {
  return `Papel atual: ${currentRole(role)}`;
}
