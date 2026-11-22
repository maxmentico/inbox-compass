// Vite turns demo source into a string without requiring Node APIs in Worker type-checks.
declare module "*.html?raw" {
  const source: string;
  export default source;
}
