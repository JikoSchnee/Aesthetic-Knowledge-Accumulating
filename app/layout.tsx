import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "审美积累中 · Taste Skill Studio",
  description: "A local visual-recipe workbench"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
