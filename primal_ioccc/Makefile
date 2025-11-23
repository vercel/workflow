CC?=cc
CFLAGS?=-std=c11 -O2 -Wall -Wextra
all: primal
primal: primal.c
	$(CC) $(CFLAGS) $< -o $@
run: primal
	./primal | head -n 5
size:
	@wc -c primal.c
clean:
	rm -f primal
