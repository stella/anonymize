declare module "fs-native-extensions" {
  export const tryLock: (fileDescriptor: number) => boolean;
}
