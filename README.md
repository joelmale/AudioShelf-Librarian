# Test web application
python audioshelf-server.py test

# Test CLI application  
python audioshelf-cli.py --version
```

### Code Quality

```bash
# Format code
black audioshelf_librarian/
isort audioshelf_librarian/

# Lint code
flake8 audioshelf_librarian/
```

## Distribution

### Building for Distribution

```bash
# Build wheel package
python setup.py bdist_wheel

# Build source distribution
python setup.py sdist

# Install locally
pip install -e .
```

### Docker Deployment

```dockerfile
# Example Dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["python", "audioshelf-librarian.py", "web", "--host", "0.0.0.0"]
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [AudioBookShelf](https://github.com/advplyr/audiobookshelf) - The amazing audiobook server
- [FastAPI](https://fastapi.tiangolo.com/) - Modern web framework
- [Mutagen](https://mutagen.readthedocs.io/) - Audio metadata library
- [Typer](https://typer.tiangolo.com/) - Modern CLI framework
