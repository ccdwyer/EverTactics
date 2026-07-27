export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (e) {
    if (specifier.startsWith('.')) return await next(specifier + '.ts', context);
    throw e;
  }
}
