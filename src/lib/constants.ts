export const saltRounds = 10

export const authExpires = () => {
  const authExpires = new Date()
  authExpires.setDate(authExpires.getDate() + 365)
  return authExpires
}
