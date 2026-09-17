/*
 * The system calls newlib expects, for a bare core with no OS: what STM32CubeIDE puts in
 * syscalls.c and sysmem.c. There is no file system or console: reads return nothing,
 * writes are accepted and dropped, the heap grows from the end of .bss up to the stack's
 * reserve (_end, _estack and _Min_Stack_Size come from the linker script). Every function
 * is weak: a project's own _write (printf out of a USART) or its own syscalls.c wins.
 */
#include <errno.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/types.h>

extern uint8_t _end;
extern uint8_t _estack;
extern uint32_t _Min_Stack_Size;

void *_sbrk(ptrdiff_t incr)
{
  static uint8_t *heap_end;
  const uint8_t *limit = (uint8_t *)&_estack - (uint32_t)&_Min_Stack_Size;
  if (heap_end == 0)
    heap_end = &_end;
  if (heap_end + incr > limit)
  {
    errno = ENOMEM;
    return (void *)-1;
  }
  uint8_t *prev = heap_end;
  heap_end += incr;
  return prev;
}

int __attribute__((weak)) _close(int file) { (void)file; return -1; }
int __attribute__((weak)) _fstat(int file, struct stat *st) { (void)file; st->st_mode = S_IFCHR; return 0; }
int __attribute__((weak)) _isatty(int file) { (void)file; return 1; }
int __attribute__((weak)) _lseek(int file, int ptr, int dir) { (void)file; (void)ptr; (void)dir; return 0; }
int __attribute__((weak)) _read(int file, char *ptr, int len) { (void)file; (void)ptr; (void)len; return 0; }
int __attribute__((weak)) _write(int file, char *ptr, int len) { (void)file; (void)ptr; return len; }
int __attribute__((weak)) _getpid(void) { return 1; }
int __attribute__((weak)) _kill(int pid, int sig) { (void)pid; (void)sig; errno = EINVAL; return -1; }
void __attribute__((weak)) _exit(int status) { (void)status; for (;;) { } }
